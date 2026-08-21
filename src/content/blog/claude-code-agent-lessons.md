---
title: '에이전트가 "끝났다"는 걸 어떻게 아는가'
description: '실제 프로덕션 프롬프트와 체인지로그, 그리고 이슈 번호까지 인용하며 "완전한 해법이 아니라 완화책"이라 스스로 적어둔 코드를 근거로, 범용 에이전트를 만들 때 가져다 쓸 다섯 가지를 정리했다.'
pubDate: 2026-08-21T15:26:18+09:00
tags: ['ai-agent', 'harness', 'claude-code', 'agent-design']
draft: true
---

[지난 글](/posts/claude-code-session-illusion/)에서 SDK가 세션 저장소를
어떻게 흉내 내는지 봤다. 이번 편은 두 갈래다. 먼저 Anthropic 팀이 자기
저장소를 실제로 어떻게 관리하는지 프로덕션 프롬프트로 확인하고, 그다음
`_internal/query.py` — SDK에서 가장 "엔진에 가까운" 파일 — 를 읽고 범용
태스크 에이전트를 만들 때 가져다 쓸 수 있는 걸 정리했다.

## Anthropic이 자기 CLI로 자기 저장소를 관리하는 법

`claude-code` 저장소의
[`.claude/commands/commit-push-pr.md`](https://github.com/anthropics/claude-code/blob/main/.claude/commands/commit-push-pr.md)는
이 팀이 실제로 쓰는 프롬프트다.

```markdown
---
allowed-tools: Bash(git checkout --branch:*), Bash(git push:*), ...
description: Commit, push, and open a PR
---
## Context
- Current git status: !`git status`
- Current git diff: !`git diff HEAD`

## Your task
...
5. You have the capability to call multiple tools in a single response.
   You MUST do all of the above in a single message. Do not use any
   other tools or do anything else.
```

`!`로 시작하는 줄은 실행 시점에 실제 셸 명령 출력을 프롬프트에 주입하는
문법이고, 마지막 지시문("반드시 한 메시지에 다 해라")은 모델이 중간에
승인을 여러 번 요청하거나 딴 길로 새지 않도록 명시적으로 못박은
프롬프트다.

[`dedupe.md`](https://github.com/anthropics/claude-code/blob/main/.claude/commands/dedupe.md)는
더 흥미롭다. 중복 이슈를 찾는 워크플로우를 **5개의 병렬 서브에이전트로
다양한 키워드 조합을 검색시키고, 그 결과를 또 다른 에이전트에 먹여서
오탐을 걸러내는** 다단계 파이프라인으로 짜여 있다. Anthropic 팀 스스로도
"하나의 큰 에이전트에게 다 시키기"보다 "역할을 쪼갠 여러 에이전트를
조합하기"를 실전에서 선택했다는 근거다.

## 엔터프라이즈 설정 한 줄의 무게

[`examples/mdm/managed-settings.json`](https://github.com/anthropics/claude-code/blob/main/examples/mdm/managed-settings.json)은
한 줄짜리다.

```json
{ "permissions": { "disableBypassPermissionsMode": "disable" } }
```

관리자가 강제한 `managed-settings.json`은 사용자의 로컬 설정보다 우선순위가
높고, `bypassPermissions` 모드 자체를 조직 차원에서 원천 차단할 수 있다.
설정 레이어링이 최소 4단(managed → flag settings → project/user/local →
session)으로 존재하고, 그중 `managed`가 다른 모든 걸 이긴다는 위계가 예제
파일 하나로 확인된다.

CHANGELOG를 보면 이 모든 게 지금도 활발히 개발 중이라는 것도 드러난다.
크로스세션 `SendMessage`에 `notify_when_idle`이 추가되고(로컬 머신의 다른
세션에게 "다음에 idle되면 알려달라"는 옵트인 알림), macOS 샌드박스의
와일드카드 read-deny 규칙이 파일명 변경으로 우회 못하게 강화되고,
self-hosted runner가 post-session 훅이 끝나기 전에 다른 러너에서
재개돼버리는 레이스 컨디션이 고쳐진다. 흥미롭게도 이 글을 쓰는 데 쓴 도구
자신의 실제 도구 목록에도 `SendMessage`, `Monitor`가 그대로 있고,
시스템 프롬프트엔 "auto memory" 섹션이 실제로 있다 — 서로 다른 자료
세 개(타입 정의, CHANGELOG, 실제 도구 목록)가 같은 그림을 가리켰다.

## `query.py`: 엔진에 가장 가까운 파일

여기부터가 이 시리즈의 원래 목적이었다 — 범용 태스크 에이전트를
만든다면 뭘 가져다 쓸까. 근거는
[`_internal/query.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)(987줄)다.

### 양방향 제어 채널은 하나의 봉투로 통일돼 있다

`_handle_control_request`를 보면, 다음 세 가지가 전부 같은 모양의
요청/응답으로 처리된다.

```python
if subtype == "can_use_tool":      # 엔진이 "이 도구 써도 돼?"라고 물음
elif subtype == "hook_callback":   # 엔진이 "이 훅 콜백 좀 실행해줘"라고 요청
elif subtype == "mcp_message":     # 엔진이 커스텀 도구에 JSON-RPC를 전달
```

반대 방향(SDK → 엔진)의 `interrupt()`, `set_permission_mode()`,
`set_model()`, `rewind_files()`도 전부 같은 `_send_control_request()`
헬퍼로 나간다. "엔진이 나에게 뭔가 물어보는 경우"와 "내가 엔진에게 뭔가
시키는 경우"가 완전히 대칭적인 하나의 프로토콜이다. 에이전트 하네스를
설계할 때 "권한 확인은 이 방식으로, 인터럽트는 저 방식으로" 식으로 채널을
늘리고 싶은 유혹이 생기는데, 여기선 그러지 않았다 — `request_id`가 붙은
요청과 그에 대응하는 응답이라는 단일 봉투로 모든 종류의 "상대방에게 뭔가
물어보고 기다리기"를 처리한다.

### 콜백은 함수가 아니라 ID로 등록된다

훅을 CLI에 알릴 때, 실제 함수를 보내는 게 아니라 문자열 ID만 보낸다.

```python
callback_id = f"hook_{self.next_callback_id}"
self.next_callback_id += 1
self.hook_callbacks[callback_id] = callback   # 함수는 로컬에 남음
```

CLI는 이 ID만 들고 있다가, 나중에 `hook_callback` 요청에 그 ID를 실어
보낸다. 커스텀 MCP 도구도 같은 패턴이다. 당연해 보이지만 실제로 자주
놓치는 규칙이다 — 에이전트의 "두뇌"가 별도 프로세스로 분리돼 있다면,
호스트가 정의한 임의의 로직을 함수 객체 자체로는 절대 넘길 수 없다.
핸들을 등록하고 로컬 디스패치 테이블에서 찾아 실행하는 게 유일한 방법이다.

### "턴이 끝났다"는 생각보다 훨씬 어려운 질문이다

가장 깊이 있는 발견이다. `_track_task_lifecycle`의 주석은 실제 이슈
번호(#1088)를 인용하며 이렇게 말한다.

> "This is a mitigation, not a complete answer to #1088." 원장이 비어있다는
> 건 "우리가 아는 한 도는 작업이 없다"는 뜻이지 "이 실행이 끝났다"는 뜻이
> 아니다. 턴의 result 프레임 *직전*에 작업이 정산되면 그 시점 원장은
> 비어있지만, 그 작업의 완료가 부모를 깨워 후속 턴을 시작시킬 수도 있다.
> (…) 이 간극은 어떤 원장으로도 못 닫는다 — 엔진 쪽에서 명시적인
> "턴 경계" 신호를 보내주지 않는 한.

처리 방식도 정교하다. 위임된 작업을 **반드시 끝나는 것**(서브에이전트류의
`local_agent`, `local_workflow`)과 **의도적으로 영원히 돌 수 있는
것**(백그라운드 셸, 모니터)으로 나누고, 후자는 절대 기다리지 않는다.

```python
# background shells and monitors run indefinitely by design, so deferring
# the close on one withholds it forever rather than briefly
```

서브에이전트나 백그라운드 작업을 지원하는 에이전트를 만든다면 반드시
부딪히는 질문이다 — "지금 응답을 사용자에게 돌려줘도 되는가?"를 무엇으로
판단할 것인가. 여기서 얻은 교훈은 두 가지다. 첫째, 위임한 작업을 "반드시
끝나는 것"과 "의도적으로 안 끝날 수 있는 것"으로 분류해야 한다 — 후자를
기다리면 영원히 응답을 못 돌려준다. 둘째, 그렇게 분류해도 완벽한 해법은
없다는 걸 인정하고 설계해야 한다. 진짜 정답은 엔진이 "이 턴은 모든
부작용을 포함해서 완전히 끝났다"는 명시적 신호를 주는 것뿐이고, 그게
없다면 지금 짜는 코드도 이 주석처럼 "완화책이지 완전한 답은 아니다"라고
정직하게 문서화하는 게 최선이다.

### 콜백 종류에 따라 스트림을 닫아도 되는 시점이 달라진다

```python
def _has_bidirectional_needs(self) -> bool:
    """... Closing stdin while any of these are configured makes every
    later request fail CLI-side with "Stream closed"."""
    return bool(self.sdk_mcp_servers or self.hooks or self.can_use_tool)
```

훅·권한 콜백·커스텀 MCP 서버 중 하나라도 등록돼 있으면, 입력을 다
보냈다고 해서 stdin을 바로 닫으면 안 된다. "입력을 다 보냈으니 스트림을
닫는다"는 단방향 파이프라인 사고방식이고, 콜백이 있는 순간 이 가정은
깨진다. 스트림을 닫아도 되는 조건은 "내가 보낼 게 없다"가 아니라 "상대방도
나에게 더 물어볼 게 없다"여야 한다.

### 자기모순적인 상태 필드를 하나만 믿지 않는다

`_error_result_text`의 주석은 실제로 겪은 버그를 그대로 남겨뒀다.

> API 실패로 끝난 실행이 `subtype: "success"`이면서 `is_error: true`로
> 온다. subtype만 보고 에러 메시지를 만들면 실제로 이런 자기모순적인
> 문장이 나왔다고 주석에 적혀 있다 — `"Claude Code returned an error
> result: success"`. 성공(success)이라는 에러가 발생했다는 문장이다.

그래서 `errors[]` → `result` 문자열 → success가 아닌 subtype → HTTP
상태 코드 → `"unknown error"` 순서의 우선순위 폴백 체인으로 고쳤다.
스트리밍·분산 시스템은 부분 실패 상황에서 필드끼리 서로 모순되는 상태를
반드시 만들어낸다고 가정하는 게 맞다.

## 다섯 가지로 정리하면

이 시리즈 네 편을 관통한 원칙만 추리면 이렇다.

| 원칙 | 근거 |
|---|---|
| 정책과 메커니즘을 분리하라 | 샌드박스 vs 권한 규칙 |
| 확장 지점은 하나의 추상으로 통일하라 | 내장 도구 = 커스텀 도구 = MCP 서버 |
| 로컬 durability가 원격 동기화보다 우선한다 | 세션 미러링의 best-effort 정책 |
| 컨텍스트는 유한한 예산이다 | `/context` 회계, 지연 로드되는 도구 |
| 제어 채널은 하나의 대칭 봉투로 통일하고, "끝났다"는 판단은 완벽할 수 없다고 인정하라 | `query.py`의 컨트롤 프로토콜과 태스크 라이프사이클 |

CLI는 여전히 클로즈드소스다. 실제 추론 루프, 도구 구현, 시스템 프롬프트
원문은 이 시리즈 네 편을 다 뒤져도 안 나온다. 그런데 "무엇을 도구로 부를
수 있고, 언제 사람에게 묻고, 실패를 어떻게 되돌리고, 턴이 끝났다는 걸
어떻게 판단하는가" — 에이전트 제품에서는 이게 사실상 아키텍처 그
자체다. 그리고 이 인터페이스는 생각보다 훨씬 정밀하게 공개돼 있었다.
