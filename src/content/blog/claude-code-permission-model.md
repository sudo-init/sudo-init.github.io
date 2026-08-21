---
title: '권한 프롬프트 문장은 누가 만드는가'
description: '"Claude가 foo.txt를 읽으려 합니다" 같은 문장은 어디서 오는지, 훅 10종류는 병렬로 도는지 순차로 도는지, 샌드박스는 권한 규칙과 왜 다른 축인지 — Claude Code의 권한·훅·샌드박스를 SDK 타입 정의로 뜯어봤다.'
pubDate: 2026-08-21T10:47:05+09:00
tags: ['ai-agent', 'harness', 'claude-code', 'permissions']
draft: true
---

[지난 글](/posts/claude-code-not-open-source/)에서 `claude-code` 저장소엔
소스가 없고, 대신 `claude-agent-sdk-python`이 그 클로즈드소스 CLI와
대화하는 프로토콜 전체를 공개하고 있다는 걸 확인했다. 그 SDK의 타입
정의를 읽다 보니, [하네스 엔지니어링](/posts/harness-engineering/)을 다룰 때
스쳐 지나가듯 적었던 문장이 하나 걸렸다.

> "권한 모델과 훅. '위험한 명령은 실행하지 마'를 프롬프트로 부탁하는 대신,
> 실행 전 훅에서 명령 자체를 검사해 차단한다. 이 글을 쓰는 도구도 이
> 구조를 쓴다."

그때는 개념만 짚고 넘어갔다. 이번엔 그 구조 자체를 열어봤다.

## 권한 프롬프트 문장은 클라이언트가 조립하지 않는다

권한 요청이 콜백으로 넘어올 때 같이 오는 컨텍스트 객체가 있다.

```python
@dataclass
class ToolPermissionContext:
    tool_use_id: str | None = None
    agent_id: str | None = None          # 서브에이전트 안에서 호출된 경우
    blocked_path: str | None = None      # 허용 경로 밖으로 나가려던 Bash 등
    decision_reason: str | None = None   # PreToolUse 훅이 남긴 사유
    title: str | None = None             # "Claude wants to read foo.txt"
    display_name: str | None = None      # 버튼 라벨용 축약형
```

`title`, `display_name`, `description`이 **이미 완성된 문장으로** 내려온다.
"Claude가 foo.txt를 읽으려 합니다"라는 문장을 클라이언트가 도구 이름에서
즉석으로 조립하는 게 아니라, CLI가 만들어서 보낸다는 뜻이다. 완전히 커스텀
권한 UI를 만들어도 이 문구 생성 로직만은 재사용해야 한다.

권한을 바꾸는 쪽(`PermissionUpdate`)도 세밀하다. `addRules` / `replaceRules`
/ `removeRules` / `setMode` / `addDirectories` / `removeDirectories` 6종류를,
`userSettings` / `projectSettings` / `localSettings` / `session` 4개 스코프
중 하나로 보낼 수 있다. "지금 이 순간만" 허용할지 "이 프로젝트에 영구히"
허용할지를 승인 UI 레벨에서 이미 구분해 둔 것이다.

## 권한 모드에 잘 안 보이는 여섯 번째 값이 있다

`permission_mode`는 문서에서 보통 `default` / `acceptEdits` /
`bypassPermissions` / `plan` / `dontAsk` 다섯 개로 소개된다. 그런데
`ClaudeSDKClient.set_permission_mode`의 docstring엔 여섯 번째가 있다.

```
'auto': A model classifier approves or denies each tool call
```

규칙 기반 allow/deny 목록이 아니라, **모델 자신이 분류기로서 매 도구
호출을 승인/거부**하는 모드다. `claude-code`의
[CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)에도
이 기능이 실제로 언급된다.

> "Improved auto mode: Monitor allow rules are now set aside while auto mode
> is active, so Monitor commands are reviewed the same way Bash commands are"

정적 규칙은 예측 가능하지만 표현력이 떨어지고, 모델 분류기는 유연하지만
그 자체가 또 하나의 신뢰 대상이 된다. 이 둘을 나란히 옵션으로 둔 건 "어느
쪽이 맞다"고 정하지 않고 사용자가 리스크 성향에 따라 고르게 한 것으로
보인다.

## 훅은 순차가 아니라 팬아웃이다

`HookEvent`로 선언된 이벤트는 정확히 10개다.

```
PreToolUse · PostToolUse · PostToolUseFailure · UserPromptSubmit
Stop · SubagentStop · SubagentStart · PreCompact
Notification · PermissionRequest
```

`PostToolUseFailure`가 `PostToolUse`와 별도 이벤트로 존재한다는 건, 도구
실행의 성공/실패 분기를 엔진이 명시적으로 구분해서 다룬다는 뜻이다.
`hooks` 옵션의 docstring엔 이렇게 적혀 있다.

> "**Dispatch order:** multiple matchers registered on the same event are
> dispatched **concurrently** by the CLI — all `hook_callback` control
> requests for a given event fire in parallel, not sequentially."

같은 이벤트에 등록된 여러 매처가 동시에 실행된다. 순서를 가정하고 짠 훅은
깨진다는 뜻이다. 그리고 서브에이전트가 병렬로 돌 때 이 이벤트들이 어떻게
귀속되는지도 문서화돼 있다.

> "When multiple sub-agents run in parallel their tool-lifecycle hooks
> interleave over the same control channel — this is the only reliable way
> to attribute each one to the correct sub-agent."

여러 서브에이전트의 이벤트가 **하나의 채널로 뒤섞여** 들어오고, 그걸
구분하는 유일한 방법이 `agent_id`라는 것까지 명시돼 있다.

이 저수준 프로토콜이 실전에서 어떻게 쓰이는지는 공식
[`hookify`](https://github.com/anthropics/claude-code/blob/main/plugins/hookify/README.md)
플러그인에서 확인했다. 사용자에게는 마크다운 규칙 파일로 보인다.

```yaml
---
name: block-dangerous-rm
enabled: true
event: bash
pattern: rm\s+-rf
action: block
---
⚠️ **Dangerous rm command detected!**
```

"rm -rf를 경고해줘"라고만 하면, 이 선언이 내부적으로는 `PreToolUseHookInput`
(`hook_event_name`, `tool_input`, `agent_id` 등)으로 컴파일돼 들어간다.
복잡한 동시성 프로토콜을 사용자에게는 절대 노출하지 않는다는 게 여기서
읽힌다.

## 샌드박스는 권한 규칙과 다른 축이다

`SandboxSettings` 타입은 권한 규칙과는 완전히 분리된 **런타임 격리** 축을
정의한다. docstring이 먼저 선을 긋는다.

> "This controls how Claude Code sandboxes bash commands for filesystem
> and network isolation. **Important:** Filesystem and network
> restrictions are configured via permission rules, not via these sandbox
> settings: Filesystem read restrictions: Use Read deny rules.
> Filesystem write restrictions: Use Edit allow/deny rules. Network
> restrictions: Use WebFetch allow/deny rules."

즉 "이 설정이 하는 일"과 "권한 규칙이 하는 일"을 docstring 첫머리에서부터
갈라놓는다. "무엇을 허용할지"(정책)와 "그 정책을 어떻게 물리적으로 강제할지"(메커니즘)가
아키텍처 레벨에서 분리돼 있다. 그리고 `enableWeakerNestedSandbox`라는
필드가 있다.

```python
enableWeakerNestedSandbox: bool
"""Enable weaker sandbox for unprivileged Docker environments
(Linux only). Reduces security. Default: False"""
```

Docker 컨테이너 안에서 다시 샌드박스를 치려면 커널 격리 기능 일부가 이미
컨테이너 경계에서 쓰여버려서 중첩이 불완전해진다는 뜻이다. "컨테이너 안에서
Claude Code를 돌린다"는 흔한 배포 시나리오를 실제로 겪고 그 트레이드오프를
옵션으로 노출한 흔적이다.

`claude-code` 저장소의
[`examples/settings/settings-strict.json`](https://github.com/anthropics/claude-code/blob/main/examples/settings/settings-strict.json)은
이 설정들이 실제로 어떻게 조합되는지 보여준다.

```json
{
  "permissions": {
    "disableBypassPermissionsMode": "disable",
    "ask": ["Bash"],
    "deny": ["WebSearch", "WebFetch"]
  },
  "allowManagedPermissionRulesOnly": true,
  "allowManagedHooksOnly": true,
  "sandbox": { "enableWeakerNestedSandbox": false }
}
```

`allowManagedHooksOnly`가 있다는 건 — 훅조차 관리자가 화이트리스트로
통제할 수 있는 공격 표면으로 취급된다는 뜻이다. 훅이 임의 셸 명령을 실행할
수 있는 이상 당연하지만, 명시적으로 잠그는 옵션이 있다는 건 실제로 문제가
됐었다는 신호일 가능성이 높다.

## 커스텀 도구는 도구가 아니라 MCP 서버다

파이썬 함수를 도구로 등록하면(`@tool` 데코레이터), 내부적으로는 **별도
프로세스를 안 띄우는 MCP 서버**가 된다. `sdk_mcp_bridge.py`의 모듈
docstring이 메커니즘을 설명한다.

> "The CLI speaks JSON-RPC to SDK MCP servers through the control channel...
> `SdkMcpBridge`는 mcp 자체의 인메모리 트랜스포트로 둘을 연결하므로, 서버가
> 구현하는 모든 메서드는 여기서 재구현되는 게 아니라 `mcp` 라이브러리가
> 그대로 디스패치한다."

Claude Code에게 "커스텀 도구"란 애초에 별종 개념이 아니라, 트랜스포트만
다른 MCP 서버일 뿐이다. 내장 도구든 커스텀 도구든 이 파이프를 공유한다는
뜻이고, 그래서 권한 검사·훅 디스패치 로직을 도구 종류별로 두 번 짤
필요가 없다.

## 다음 편

권한·훅·샌드박스가 "지금 이 도구 호출을 허용할지"를 다룬다면, 다음 편은
"이 세션 자체가 어디에 어떻게 저장되는지"를 다룬다. 커스텀 저장소를
붙였을 때 CLI가 실제로 그걸 아는지 확인하다가, SDK가 가짜 디렉터리를 만들어
CLI를 속이고 있다는 걸 발견했다.
