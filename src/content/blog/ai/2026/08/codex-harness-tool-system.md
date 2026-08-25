---
title: '코드로 읽는 Codex 하네스 (3) — 함수 호출 하나가 실행되기까지'
slug: codex-harness-tool-system
category: ai
description: 'tools 크레이트와 core/src/tools를 열어, 모델이 뱉은 함수 호출이 실제 실행으로 이어지는 경로와 실패를 모델에게 되돌려주는 방식을 코드로 확인했다.'
pubDate: 2026-08-21T14:00:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
draft: true
---

[2편](/posts/codex-harness-agent-loop/)에서 모델을 부르는 경로를 봤다.
그런데 모델이 텍스트만 뱉지 않고 함수 호출(tool call)을 뱉으면 그다음엔
무슨 일이 일어날까. 이번 편은 그 경로를 연다. 커밋은 지난 편과 같은
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## "tools"라는 이름의 코드가 두 군데 있다

찾아보면 헷갈리기 딱 좋다. 워크스페이스 루트에 `tools/`라는 crate가
따로 있고, `core/src/` 안에도 `tools/`라는 모듈이 또 있다. 둘은 역할이
다르다.

- **`tools/`(top-level crate)** — 모델에 보여줄 스펙과 스키마만 다룬다.
  `ToolDefinition`(이름, 설명, JSON 스키마), `JsonSchema` 파서, 그리고
  `ToolExecutor<Invocation>` 같은 트레이트. crate 문서 첫 줄에 이렇게
  적혀 있다: "codex-core 밖에서도 살 수 있는, 공유되는 도구 정의와 Responses
  API 도구 원시 타입." 즉 codex-core에 묶이지 않는 순수 스펙 계층이다.
- **`core/src/tools/`(모듈)** — 실제 배선이다. `registry.rs`, `router.rs`,
  `approvals.rs`, `sandboxing.rs`, `orchestrator.rs`, 그리고 실제 구현체가
  들어 있는 `runtimes/`, `handlers/` 디렉터리.

"스펙과 런타임을 분리한다"는 설계 의도는
[`tool_executor.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/tools/src/tool_executor.rs)의
`ToolExecutor` 트레이트 주석에 그대로 적혀 있다.

> Implementations keep the model-visible spec tied to the executable
> runtime. Host crates can layer routing, hooks, telemetry, or other
> orchestration on top without reopening the spec/runtime split.

## 도구 목록을 어떻게 노출할지도 정책이다

모델에게 도구를 "그냥 다 보여준다"가 아니다.
[`tool_executor.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/tools/src/tool_executor.rs)에
`ToolExposures` 비트플래그가 있고, 도구마다 세 개의 독립된 표면 중 어디에
노출할지 조합할 수 있다.

```rust
const DIRECT = 0b001;      // 초기 도구 목록에 항상 포함
const DEFERRED = 0b010;    // tool_search로만 찾을 수 있음
const CODE_MODE = 0b100;   // 중첩된 Code Mode 스크립트에서만 호출 가능
```

`DEFERRED` 플래그가 붙은 도구는 처음부터 모델의 도구 목록에 실리지 않는다. 대신
`tool_search`라는 메타 도구(`TOOL_SEARCH_TOOL_NAME`, 기본 검색 결과 8개)로
모델이 필요할 때 찾아 쓴다. 2편에서 본 컨텍스트 압축과 결이 같은 문제다 —
도구가 수십 개로 늘어나면 스펙(설명 + JSON 스키마)만으로도 프롬프트가
무거워진다. 그래서 자주 안 쓰는 도구는 처음부터 안 보여주고, 검색으로만
닿게 해서 상시 노출되는 토큰 양을 줄인다.

## 실제로 어떤 도구가 있나

`core/src/tools/handlers/`를 그대로 나열하면 Codex가 모델에게 실제로 쥐어주는
도구 인벤토리가 보인다.

| 분류 | 도구 |
| --- | --- |
| 실행 | `shell`, `unified_exec` |
| 파일 수정 | `apply_patch` |
| 외부 연동 | `mcp`, `mcp_resource` |
| 계획/진행 | `plan`, `get_context_remaining`, `new_context_window` |
| 사용자 상호작용 | `request_user_input`, `request_permissions`, `send_user_message_async` |
| 도구 확장 | `tool_search`, `list_available_plugins_to_install`, `request_plugin_install`, `dynamic` |
| 서브에이전트 | `multi_agents`, `multi_agents_v2` |
| 기타 | `view_image`, `sleep`, `wait_for_environment`, `current_time` |

`multi_agents`/`multi_agents_v2`가 특히 흥미롭다. `router.rs`를 보면
`spawn_agent`, `send_message`, `followup_task` 같은 이름이 나온다 — 서브
에이전트를 띄우고 통신하는 것도 별도 프로토콜이 아니라 **똑같은 함수
호출 경로를 타는 도구 중 하나**로 구현돼 있다. 1편에서 워크스페이스
목록에 있던 `agent-graph-store`, `agent-identity` crate가 여기로
이어진다. 멀티 에이전트 오케스트레이션 자체는 범위가 커서 이 시리즈에서는
다루지 않지만, "에이전트를 새로 띄운다"는 동작이 하네스 안에서는 그냥
도구 호출 하나라는 점은 짚어둘 만하다.

## 실패도 두 종류로만 나눈다

도구 실행이 실패했을 때 하네스가 어떻게 반응하는지가
[`function_call_error.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/tools/src/function_call_error.rs)
열 줄에 압축돼 있다.

```rust
pub enum FunctionCallError {
    #[error("{0}")]
    RespondToModel(String),
    #[error("Fatal error: {0}")]
    Fatal(String),
}
```

이게 전부다. 파일이 존재하지 않는다, 명령이 실패했다, 인자가 스키마와
안 맞는다 — 이런 실패는 대부분 `RespondToModel`이다. 에러 메시지를 함수
호출 결과로 그대로 모델에게 돌려주고, 모델이 다음 스텝에서 다시 시도하거나
다른 방법을 찾게 놔둔다. 반면 `Fatal`은 턴 자체를 중단시키는 진짜 치명적
오류다. [지난 글](/posts/harness-engineering/)에서 "완료했습니다"라고
보고했지만 테스트가 한 번도 실행되지 않았던 문제는 테스트 실행 결과를
강제로 다시 모델에게 돌려주는 하네스가 있어야 고쳐진다고 썼던 그 되돌림
경로가, 여기서는 딱 두 줄짜리 enum으로 존재한다. 실패의
심각도를 매번 판단하는 대신, 애초에 "모델이 계속 일할 수 있는 실패"와
"턴을 멈춰야 하는 실패"로 도구 작성 시점에 분류해 버린다.

## 실행 앞뒤로 훅과 승인이 낀다

[`core/src/tools/registry.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/core/src/tools/registry.rs)를
보면 모든 도구 실행이 `run_pre_tool_use_hooks`와 `run_post_tool_use_hooks`로
감싸져 있다. 이름부터 "실행 전에 개입할 수 있다"는 걸 알려준다.

승인 쪽은
[`approvals.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/core/src/tools/approvals.rs)에
있는데, 여기서 1편에서 봤던 `EventMsg::GuardianWarning`의 정체가
드러난다. `approvals.rs`는 `guardian` 모듈을 가져와서
`review_approval_request`, `routes_approval_policy_to_guardian` 같은
함수를 쓴다. 즉 "이 명령을 실행해도 되는가"를 판단하는 경로가 두 갈래다.

- 사람에게 물어보는 일반 승인 흐름 (`AskForApproval` 정책)
- **Guardian**이라는 별도의 자동 리뷰어가 먼저 검토하는 흐름
  (`routes_approval_policy_to_guardian`으로 어떤 요청을 Guardian에게
  돌릴지 결정)

사람이 매번 붙어서 승인하지 않아도, Guardian이 위험도를 자동으로 판단해서
경고(`GuardianWarning`)를 내보내거나 실행을 막을 수 있다는 뜻이다. 승인
정책과 샌드박스 정책이 실제로 어떻게 강제되는지는 5편에서 `protocol.rs`의
`SandboxPolicy`와 `sandboxing/`의 OS별 구현으로 더 깊이 본다. 이번 편에서는 "실행 직전에 걸리는
검문소가 최소 두 겹(훅, 승인/Guardian)"이라는 것만 확인하고 넘어간다.

## 정리

| 질문 | 담당 코드 |
| --- | --- |
| 모델에게 뭘 보여줄까 | `tools/`의 `ToolDefinition`, `JsonSchema` |
| 언제 보여줄까(즉시/검색 전용/코드모드 전용) | `ToolExposures` 비트플래그, `tool_search` |
| 실제로 어떻게 실행할까 | `core/src/tools/router.rs`, `registry.rs`, `runtimes/` |
| 실행 전에 막을 수 있나 | `run_pre_tool_use_hooks`, `approvals.rs`, Guardian |
| 실패하면 어떻게 되나 | `FunctionCallError::RespondToModel` vs `Fatal` |

## 다음 편

도구 인벤토리 중 `apply_patch`만 따로 파본다. 왜 파일 수정을 셸 명령이
아니라 전용 도구로 뺐는지, `apply-patch/` crate의 `streaming_parser.rs`가
왜 924줄이나 되는지, 그리고 컨텍스트 라인이 조금 달라도 패치가 적용되는
퍼지 매칭이 실제로 어떻게 동작하는지를 본다.
