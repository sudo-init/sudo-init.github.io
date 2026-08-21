---
title: '에이전트가 "끝났다"는 걸 어떻게 아는가'
description: '실제 프로덕션 프롬프트, 5,693줄짜리 CHANGELOG, 그리고 이슈 번호까지 인용하며 "완전한 해법이 아니라 완화책"이라 스스로 적어둔 코드를 근거로, 범용 에이전트를 만들 때 가져다 쓸 걸 정리했다.'
pubDate: 2026-08-21T15:26:18+09:00
tags: ['ai-agent', 'harness', 'claude-code', 'agent-design']
draft: true
---

[지난 글](/posts/claude-code-session-illusion/)에서 SDK가 세션 저장소를
어떻게 흉내 내는지 봤다. 이번 편은 세 갈래다. Anthropic 팀이 자기
저장소를 실제로 어떻게 관리하는지 프로덕션 프롬프트로 확인하고, 그
CLI가 얼마나 빠르게 움직이는지 CHANGELOG 370개 버전으로 확인하고,
마지막으로 `_internal/query.py` — SDK에서 가장 "엔진에 가까운" 파일 —
를 읽고 범용 태스크 에이전트를 만들 때 가져다 쓸 수 있는 걸 정리했다.
이 시리즈의 마지막 편이다.

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

## CHANGELOG 370개 버전이 말해주는 것

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

이 팀이 설정 하나도 이렇게 촘촘히 관리한다면, 릴리스는 어떨까 싶어서
[CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)를
처음부터 끝까지 — 370개 버전, 5,693줄 — 훑었다. 날짜는 안 적혀 있지만
버전 번호 순서로 "무엇이 어떤 순서로 생겨났는지"는 정확히 확인할 수
있었다.

**공식 SDK가 셋 다 열려 있는 건 아니었다.** 1편에서 "Python SDK는 MIT,
`claude-code`는 all-rights-reserved"라고 정리하면서 정작 TypeScript
SDK(`claude-agent-sdk-typescript`)는 제대로 안 봤다. 다시 열어보니
`src/` 디렉터리 자체가 없고, `LICENSE.md`를 디코딩하면 `claude-code`와
똑같은 문장이 나온다.

> "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's
> Commercial Terms of Service."

공식 저장소 세 개 중 진짜로 소스가 열려 있는 건 Python SDK 하나뿐이다.
CHANGELOG를 보면 두 SDK가 같은 버전에서 동시에 릴리스됐다는 것도
확인된다.

> - Released TypeScript SDK: import @anthropic-ai/claude-code to get started
> - Released Python SDK: pip install claude-code-sdk to get started

패키지 이름도 지금과 다르다. `claude-code-sdk`, `@anthropic-ai/claude-code`
— TypeScript SDK README의 "Migrating from the Claude Code SDK" 섹션이
이 이름이 나중에 "Claude Agent SDK"로 바뀐 흔적을 확인해준다. 코딩
전용 도구에서 범용 에이전트 도구로 프레이밍이 넓어진 시점과 겹칠
것이다. 같은 버전 근처엔 훅의 시작점도 있었다.

> "Released hooks. Special thanks to community input in
> [anthropics/claude-code#712](https://github.com/anthropics/claude-code/issues/712).
> Docs: https://code.claude.com/docs/en/hooks"

**그런데 SDK엔 없는 훅이 CLI엔 있다.** 2편에서 봤듯 Python SDK가 등록할
수 있는 `HookEvent`는 정확히 10개다. CHANGELOG를 계속 읽다 보면 이
목록에 없는 이름이 나온다 — `SessionStart`, `SessionEnd`,
`PermissionDenied`.

> - Hooks: Introduced SessionEnd hook
> - Hooks: Added SessionStart hook for new session initialization
> - `SessionStart` hooks can now return `reloadSkills: true` to re-scan
>   skill directories
> - Fixed `SessionEnd` hooks being killed after 1.5 s on exit regardless
>   of `hook.timeout`
> - Added `PermissionDenied` hook that fires after auto mode classifier
>   denials — return `{retry: true}` to tell the model it can retry

전부 실제로 존재하고 계속 개선되는 기능이다. `types.py`를 다시 뒤져보면
`SessionStartHookSpecificOutput`이라는 타입은 있다 — **훅이 반환하는
값의 모양**은 정의돼 있다. 하지만 `HookEvent` 리터럴 자체엔
`"SessionStart"`가 없다. Python SDK로는 `hooks` 옵션에 `SessionStart`
콜백을 등록할 방법이 없고, `PermissionDenied`는 아예 흔적도 없다.
CHANGELOG에 힌트가 하나 있다.

> "Improved hook configuration error: configuring a prompt- or
> agent-type hook for `SessionStart`/`Setup`/`SubagentStart` now shows a
> clear 'use a command-type hook instead' error"

`SessionStart`류는 프롬프트형·에이전트형이 아니라 커맨드형(셸 명령)
훅으로만 설정할 수 있다는 뜻이다. 세션이 막 시작하는 시점엔 SDK와
CLI 사이의 양방향 제어 채널이 아직 준비되지 않았을 수 있으니(뒤에서
다룰 `_has_bidirectional_needs`), 애초에 인프로세스 콜백으로 받을
방법이 구조적으로 없을 가능성이 있다 — 다만 이건 코드로 직접 확인한 게
아니라 CHANGELOG 문구에서 추론한 것이다. 이유가 무엇이든, 3편에서 본
"forward-compatible: skip unrecognized message types" 원칙이 여기서
실물로 확인된다. **CLI가 SDK보다 빠르게 움직일 수 있다는 게 설계
의도로만 있는 게 아니라, 지금 이 순간 SDK 타입 정의와 CLI 기능 사이에
벌어진 간극으로 실제로 존재한다.**

CHANGELOG는 다른 것도 여럿 확인해줬다. 2편에서 다룬 `auto` 권한 모드는
처음부터 지금 모습이 아니었다 — 별도 플래그(`--enable-auto-mode`)로
켜야 하는 실험 기능이었고, 한동안 Max 구독자·Opus 4.7 한정이었다.

> - Auto mode no longer requires `--enable-auto-mode`
> - Auto mode is now available for Max subscribers when using Opus 4.7
> - Fixed auto mode not respecting explicit user boundaries ("don't
>   push", "wait for X before Y") even when the action would otherwise
>   be allowed

3편에서 `ContextUsageResponse`의 `deferredBuiltinTools`를 보고 "당장
안 쓰는 도구는 지연 로드한다"고 추정했던 것도 정확한 숫자로 확인됐다.

> "Enabled MCP tool search auto mode by default for all users. When MCP
> tool descriptions exceed 10% of the context window, they are
> automatically deferred and discovered via the `MCPSearch` tool instead
> of being loaded upfront."

**컨텍스트 윈도의 10%**를 넘는 순간 MCP 도구 설명이 프롬프트에서
빠지고, 필요할 때 `MCPSearch`라는 전용 도구로 찾아 쓴다. 서브에이전트도
한 번에 지금 모습으로 나온 게 아니었다.

> - You can now create custom subagents for specialized tasks! Run
>   `/agents` to get started
> - Introducing the Explore subagent. Powered by Haiku it'll search
>   through your codebase efficiently to save context!
> - Subagents: claude can dynamically choose the model used by its
>   subagents

사용자 정의 서브에이전트가 먼저 나오고, 특정 역할(검색)엔 굳이 Haiku로
모델을 고정한 내장 서브에이전트가 뒤따르고, 마지막에야 "서브에이전트가
쓸 모델을 동적으로 고른다"는 유연한 형태로 넘어갔다. 고정 배정 → 동적
선택이라는 순서도, 타입 정의만 봐서는 알 수 없는 부분이었다.

마지막으로, CHANGELOG를 읽다가 뜻밖의 루프가 하나 닫혔다. 크로스세션
`SendMessage`에 `notify_when_idle`이 추가되고(로컬 머신의 다른 세션에게
"다음에 idle되면 알려달라"는 옵트인 알림), macOS 샌드박스의 와일드카드
read-deny 규칙이 파일명 변경으로 우회 못하게 강화되는 식의 변경들이
지금도 이어진다. 흥미롭게도 이 글을 쓰는 데 쓴 도구 자신의 실제 도구
목록에도 `SendMessage`, `Monitor`가 그대로 있고, 시스템 프롬프트엔
"auto memory" 섹션이 실제로 있다 — 서로 다른 자료 세 개(타입 정의,
CHANGELOG, 실제 도구 목록)가 같은 그림을 가리켰다.

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

이 원장이 실제로 어떻게 소비되는지는 메시지를 읽어 라우팅하는 메인
루프 `_read_messages`에 있다. `result` 메시지가 오면 진행 중인 태스크가
있는지부터 확인한다.

```python
if self._inflight_tasks:
    logger.debug(
        "Result received with %d task(s) in flight; keeping stdin open",
        len(self._inflight_tasks),
    )
else:
    self._first_result_event.set()
```

이 이벤트가 켜져야만 stdin이 실제로 닫힌다. `result` 메시지 하나는 "이
턴이 끝났다"는 신호일 뿐이고, "지금 stdin을 닫아도 된다"는 신호는 남은
태스크가 없을 때만 성립한다. 태스크 하나가 끝나면 부모를 다시 깨우고,
그 후속 턴의 result가 원장이 빈 채로 도착해야 비로소 stdin이 닫힌다.

그런데 이 메커니즘도 스스로 완벽하지 않다고 인정한다.
`wait_for_result_and_end_input`의 docstring엔 두 번째 알려진 한계가
남아 있다.

> "Known limitation: the event is one-shot and is not aware of prompt
> messages still queued CLI-side, so an AsyncIterable prompt that yields
> several user messages (several turns) releases the hold at the first
> turn boundary with no tracked tasks; control requests from later turns
> can then find stdin closed. Single-message and string prompts — the
> common one-shot shapes — are fully covered."

백그라운드 태스크가 하나도 없는 상태에서 여러 턴을 스트리밍으로 보내는
프롬프트를 쓰면, 첫 턴 경계에서 이 hold가 풀려버려 이후 턴의 컨트롤
요청이 닫힌 stdin을 만날 수 있다는 뜻이다. 흔한 단일 메시지·문자열
프롬프트는 문제없지만, 멀티턴 스트리밍이라는 덜 흔한 조합에서는 `#1088`
이 다른 얼굴로 다시 나타난다.

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
나에게 더 물어볼 게 없다"여야 한다. 앞서 본 `SessionStart` 훅이 커맨드형
으로만 제한된 이유도 아마 이 지점과 맞닿아 있을 것이다 — 채널이 준비되기
전엔 물어볼 수도, 답할 수도 없다.

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

### 죽은 프로세스의 마지막 말을 사람이 읽게 바꾼다

CLI가 `is_error: true`인 result를 낸 뒤 셸 스크립트용으로 일부러 0이
아닌 코드로 종료하면, 서브프로세스 계층에서는 "종료 코드 1"이라는
정보 없는 `ProcessError`만 올라온다. `_read_messages`는 이걸 그대로
던지지 않는다.

```python
if isinstance(e, ProcessError) and self._last_error_result is not None:
    error_text = (
        f"Claude Code returned an error result: "
        f"{_error_result_text(self._last_error_result)}"
    )
    pending_error = ResultError(
        error_text, data=self._last_error_result, exit_code=e.exit_code
    )
```

직전에 받아둔 마지막 에러 result를 앞서 본 그 우선순위 폴백 체인
(`_error_result_text`)에 통과시켜서, "종료 코드 1"을 실제 원인 문장으로
바꿔치기한다. 그리고 이 순간 아직 응답을 기다리던 모든 컨트롤 요청에도
같은 에러를 즉시 물려준다 — 각자 최대 60초 타임아웃을 따로 기다리게
두지 않고, 원인을 아는 순간 전부 한 번에 실패시킨다.

### 취소는 어디까지 책임지고, 어디서부터 넘겨야 하는가

`Query.close()`는 통째로 `anyio.CancelScope(shield=True)`로 감싸져
있다. `close()`는 이미 취소된 태스크의 `__aexit__`에서 불릴 수 있는데,
여기 shield가 없으면 정리 작업이 시작하자마자 취소되면서 CLI
서브프로세스가 그대로 leak되기 때문이다.

그런데 이 shield는 무한정 기다리지 않는다. docstring이 셋으로 나눠
책임을 정확히 그어둔다 — 트랜스크립트 미러 flush(이미 별도로 shield
됨), 인프로세스 MCP 서버 정리(서버별로 유예 시간을 두고 자체적으로
bound됨), 그리고 `transport.close()`(SDK 기본 구현은 최악의 경우 20초
안에 끝나도록 bound됨). 사용자가 직접 넘긴 커스텀 `Transport`에
대해서는 이렇게 못박는다.

> "For a custom Transport... that is arbitrary user code, and an
> enclosing anyio cancel scope can no longer interrupt it: a custom
> close() that never returns hangs disconnect()... Bounding it here
> instead would only abandon a wedged transport half-closed, which is
> the very leak this shield exists to prevent, so the obligation belongs
> on the implementation."

프레임워크가 남의 코드에 임의로 타임아웃을 씌우면, 오히려 절반만 정리된
상태로 방치하는 게 더 나쁠 수 있다는 뜻이다. 그래서 "당신이 만든
Transport라면, bound된 `close()`를 만드는 건 당신 책임"이라고 계약으로
못박아버린다. `_close_impl`의 정리 순서엔 실제 이슈 번호도 남아 있다.

```python
self._message_send.close()
# Do NOT close the receive side — it belongs to the consumer... (#859)
```

메시지 스트림의 송신 쪽은 여기서 닫지만, 수신 쪽은 일부러 안 닫는다.
anyio의 `receive_nowait()`가 버퍼보다 `_closed` 상태를 먼저 확인하기
때문에, 여기서 수신 쪽까지 닫으면 아직 다 읽지 않은 소비자가 버퍼에
남은 메시지를 못 받고 `ClosedResourceError`를 맞는다 — 실제로 겪은
버그(#859)의 흔적이다.

### 동시성 프레임워크가 다르면 취소 방식도 다르다

Query는 읽기 루프·입력 스트리밍·컨트롤 요청 처리 같은 백그라운드
태스크를 "어느 태스크에서든 취소 가능해야 한다"는 조건으로 관리한다.
그런데 이걸 anyio의 `TaskGroup`으로 하면 안 된다는 게
`_task_compat.py`의 모듈 docstring에 나온다.

> "anyio's TaskGroup cannot be used for this because its cancel scope
> has task affinity: exiting it from a different task either raises
> RuntimeError... or busy-spins... on the asyncio backend."

취소 스코프를 연 태스크가 아닌 다른 태스크에서 닫으려고 하면 예외가
나거나, 최악의 경우 조용히 CPU를 다 먹는 무한 스핀에 빠진다는 뜻이다.
Python의 async generator finalizer는 원래 코드를 시작한 태스크와 다른
태스크에서 실행될 수 있으니, 실제로 만날 수 있는 문제다. 그래서 SDK는
`sniffio`로 지금 asyncio 위에서 도는지 trio 위에서 도는지 감지해서,
백엔드별로 다른 취소 프리미티브를 쓰는 `TaskHandle`을 직접 구현했다.
asyncio는 `loop.create_task()`로, trio는
`trio.lowlevel.spawn_system_task`를 자체 `CancelScope`로 감싸서 쓴다.

디테일 하나만 더. `_AsyncioTaskHandle.wait()`는 `await self._task`를
직접 쓰지 않는다.

> "Awaiting the task object directly would tie the two tasks together:
> cancelling the waiter cancels the wrapped task as well, and the waiter
> cannot tell its own CancelledError from the wrapped task's."

기다리는 쪽과 기다려지는 쪽의 취소를 서로 독립적으로 유지하려고, 별도의
`anyio.Event`를 하나 더 만들어서 완료 신호로 쓴다. 비동기 프레임워크
위에서 "다른 태스크가 끝나길 기다리는" 코드를 짤 때 흔히 놓치는
지점이다.

## 일곱 가지로 정리하면

이 시리즈 네 편을 관통한 원칙만 추리면 이렇다.

| 원칙 | 근거 |
|---|---|
| 정책과 메커니즘을 분리하라 | 샌드박스 vs 권한 규칙 |
| 확장 지점은 하나의 추상으로 통일하라 | 내장 도구 = 커스텀 도구 = MCP 서버 |
| 로컬 durability가 원격 동기화보다 우선한다 | 세션 미러링의 best-effort 정책 |
| 컨텍스트는 유한한 예산이다 | `/context` 회계, 10%에서 트리거되는 지연 로드 |
| SDK의 타입 정의는 CLI의 스냅샷일 뿐이다 | `SessionStart`/`SessionEnd`/`PermissionDenied` 훅 갭, CHANGELOG 370개 버전 |
| 제어 채널은 하나의 대칭 봉투로 통일하고, "끝났다"는 판단은 완벽할 수 없다고 인정하라 | `query.py`의 컨트롤 프로토콜과 태스크 라이프사이클 |
| 종료·취소의 책임 경계를 계약으로 명시하라 | `close()`의 shield, 커스텀 Transport 계약, 실제 이슈(#859)로 남은 스트림 정리 순서 |

CLI는 여전히 클로즈드소스다. 실제 추론 루프, 도구 구현, 시스템 프롬프트
원문은 이 시리즈 네 편을 다 뒤져도 안 나온다. 그런데 "무엇을 도구로 부를
수 있고, 언제 사람에게 묻고, 실패를 어떻게 되돌리고, 턴이 끝났다는 걸
어떻게 판단하는가" — 에이전트 제품에서는 이게 사실상 아키텍처 그
자체다. 그리고 이 인터페이스는 생각보다 훨씬 정밀하게, 그리고 훨씬 빠르게
움직이는 채로 공개돼 있었다.
