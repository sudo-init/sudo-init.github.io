---
title: '코드로 읽는 Codex 하네스 (11) — 훅은 셸 명령이거나 MCP 도구다'
description: 'hooks 크레이트를 열어, 시리즈 내내 인용만 했던 run_pre_tool_use_hooks 같은 함수들의 실체와 11가지 훅 이벤트, 신뢰 게이트를 코드로 확인했다.'
pubDate: 2026-08-22T19:30:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
draft: true
---

이 시리즈 내내 `run_pre_tool_use_hooks`, `run_pre_compact_hooks`,
`run_pending_session_start_hooks`처럼 훅 관련 함수를 계속 인용만 했다.
이번 편에서 `hooks/` crate 자체를 연다. 커밋은 이 시리즈에서 계속 쓰는
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## 이름부터 짚고 가자

`hooks/src/engine/mod.rs`를 열자마자 눈에 띈 게 있다. 이 crate의 핵심
실행기 이름이 그냥 이렇다.

```rust
pub(crate) struct ClaudeHooksEngine {
    pub(crate) handlers: Vec<ConfiguredHandler>,
    warnings: Vec<String>,
    required_load_errors: Vec<String>,
    pub(crate) command_runtime: CommandHookRuntime,
    pub(crate) mcp_executor: Arc<dyn HookMcpExecutor>,
}
```

이 이름을 쓰는 파일이 `hooks/src/engine/mod.rs`, `registry.rs`,
`events/pre_tool_use.rs`, `events/post_tool_use.rs`,
`events/compact.rs`, `events/session_start.rs`,
`events/session_end.rs`, `events/user_prompt_submit.rs`,
`events/permission_request.rs`까지 crate 전체에 걸쳐 있다. 오타나
우연이 아니라 이 실행기의 정식 이름이다. 코드에 이유를 설명하는 주석은
없어서 왜 이렇게 지었는지는 알 수 없지만, 뒤에서 볼 이벤트 이름 목록을
보면 왜 이런 이름이 붙었는지 짐작이 간다.

## 이벤트는 11가지다

[`hooks/src/lib.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/hooks/src/lib.rs)의
`HOOK_EVENT_NAMES`에 전체 목록이 있다.

```rust
pub const HOOK_EVENT_NAMES: [&str; 11] = [
    "PreToolUse", "PermissionRequest", "PostToolUse",
    "PreCompact", "PostCompact",
    "SessionStart", "SessionEnd",
    "UserPromptSubmit",
    "SubagentStart", "SubagentStop",
    "Stop",
];
```

이 시리즈에서 이미 만난 지점들이 절반이다.

| 이벤트 | 이 시리즈에서 만난 곳 |
| --- | --- |
| `PreToolUse` / `PostToolUse` | [3편](/posts/codex-harness-tool-system/) — `run_pre_tool_use_hooks` |
| `PermissionRequest` | [7편](/posts/codex-harness-exec-policy/) — 직접 다루진 않았지만 `GranularApprovalConfig.rules`(승인 프롬프트 세분화)와 맞닿아 있다 |
| `PreCompact` / `PostCompact` | [2편](/posts/codex-harness-agent-loop/) — 압축 앞뒤로 걸리는 훅 |
| `SubagentStart` / `SubagentStop` | [9편](/posts/codex-harness-multi-agent/) — 직접 다루진 않았지만 서브 에이전트 생애주기(`agent-graph-store`)와 맞닿아 있다 |
| `SessionStart` / `SessionEnd` | [1편](/posts/codex-harness-map/) — `run_pending_session_start_hooks` |

각 이벤트마다 `PreToolUseRequest`/`PreToolUseOutcome`처럼 요청·결과
타입이 따로 있어서, 이벤트별로 훅에 뭐가 들어오고 뭐가 나가는지가
타입으로 고정돼 있다.

## 결과는 세 가지뿐이다

`types.rs`의 `HookResult`가 훅 하나의 결과를 세 가지로 제한한다.

```rust
pub enum HookResult {
    Success,
    FailedContinue(Box<dyn std::error::Error + Send + Sync + 'static>),
    FailedAbort(Box<dyn std::error::Error + Send + Sync + 'static>),
}
```

성공, "실패했지만 나머지 훅과 본 작업은 계속 진행", "실패했고 나머지
훅도 건너뛰고 작업 자체를 중단"이다. [2편](/posts/codex-harness-agent-loop/)에서
본 `PreCompactHookOutcome::Stopped`가 정확히 어디서 나오는지도
`core/src/hook_runtime.rs`(1,108줄)의 `run_pre_compact_hooks`에서
확인된다 — 등록된 훅들을 돌린 결과를 모은 `outcome.should_stop` 값이
`true`면 `Stopped`, 아니면 `Continue`다. 훅 하나하나의 결과가
`HookResult`라면, `PreCompactHookOutcome`은 그 결과들을 모아 이번
압축을 중단시킬지 결정하는 상위 집계값인 셈이다.

## 입력과 출력에는 각각 JSON 스키마가 있다

`schema.rs`를 보면 이벤트마다 입력·출력 스키마 파일이 따로 생성된다.

```rust
const PRE_TOOL_USE_INPUT_FIXTURE: &str = "pre-tool-use.command.input.schema.json";
const PRE_TOOL_USE_OUTPUT_FIXTURE: &str = "pre-tool-use.command.output.schema.json";
const PERMISSION_REQUEST_INPUT_FIXTURE: &str = "permission-request.command.input.schema.json";
```

훅이 그냥 종료 코드(exit code)만 돌려주는 게 아니라는 뜻이다. 훅
프로세스는 구조화된 JSON을 표준 입력으로 받고, 구조화된 JSON을 표준
출력으로 돌려줄 수 있다. `PermissionRequest` 이벤트라면 출력 스키마에
"허용"/"거부"/"사람에게 물어보기" 같은 값이 들어갈 자리가 있다는 뜻이고,
`PostToolUse`라면 도구 실행 결과에 대한 코멘트를 실어 보낼 자리가
있다는 뜻이다.

## 훅은 셸 명령이거나 MCP 도구다

`engine/mod.rs`의 `HookListEntryHandler`를 보면 훅을 실행하는 방식이
두 가지다.

```rust
pub enum HookListEntryHandler {
    Command { command: String, r#async: bool },
    McpTool { server: String, tool: String },
}
```

훅을 셸 명령으로 등록할 수도 있고, 이미 연결된 MCP 서버의 도구 하나를
훅으로 바로 지정할 수도 있다. `command_runtime: CommandHookRuntime`과
`mcp_executor: Arc<dyn HookMcpExecutor>`가 `ClaudeHooksEngine` 안에
나란히 있는 이유다 — 훅이 어느 쪽으로 등록되든 같은 엔진이 처리한다.

## 아무 훅이나 바로 실행되지는 않는다

`HookListEntry` 구조체에 `trust_status: HookTrustStatus`와
`current_hash: String` 필드가 있다. `HookTrustStatus`는
`Trusted`/`Untrusted` 두 값이다. 새로 발견된 훅, 혹은 내용이 바뀐
훅은 `Untrusted` 상태로 시작하는 것으로 보이고, `current_hash`로 훅
스크립트의 내용을 해시해서 들고 있다 — 사용자가 한 번 승인한 뒤 훅
스크립트 내용이 몰래 바뀌면 해시가 달라지니 다시 신뢰 확인을 요구할 수
있는 구조다. 저장소에 있는 셸 스크립트 하나가 매 턴 자동으로 실행되는
게 훅인데, 그 스크립트를 아무나 마음대로 바꿔서 다음 턴에 조용히 실행되게
만들 수 있다면 심각한 구멍이 된다. 내용 해시로 그 구멍을 막아 둔
것으로 보인다.

## 플러그인도 훅을 들고 올 수 있다

`declarations.rs`의 `plugin_hook_declarations`는 플러그인 번들
(`PluginHookSource`)에 선언된 훅을 뽑아낸다. [3편](/posts/codex-harness-tool-system/)에서
본 `request_plugin_install` 도구로 설치한 플러그인이 자기만의 훅을
같이 들고 들어올 수 있다는 뜻이다. 훅 키는
`"{plugin_id}:{source_relative_path}"` 형태로 만들어져서, 어느
플러그인의 어느 파일에서 온 훅인지 항상 추적 가능하게 돼 있다.

## 정리

| 질문 | 담당 코드 |
| --- | --- |
| 핵심 실행기 이름 | `ClaudeHooksEngine`(`hooks/src/engine/mod.rs`) |
| 이벤트 종류 | 11가지(`HOOK_EVENT_NAMES`) |
| 훅 하나의 결과 | `HookResult::Success`/`FailedContinue`/`FailedAbort` |
| 입출력 형식 | 이벤트별 JSON 스키마(`schema.rs`) |
| 실행 방식 | 셸 명령 또는 MCP 도구(`HookListEntryHandler`) |
| 무단 변조 방지 | `HookTrustStatus`, `current_hash` |
| 플러그인 훅 | `plugin_hook_declarations` |

## 다음 편(시즌 2 마지막)

지금까지 execpolicy, Code Mode, 멀티 에이전트, 멀티 프로바이더, 훅까지
다섯 개 주제를 팠다. 다음 편에서는 그보다 작은 조각들 — 영속 셸 세션
(`unified_exec`, `shell_snapshot.rs`)과 원격/클라우드 실행
(`cloud-tasks`, `noise_channel`) — 을 묶어서 짧게 정리하고 시즌 2를
마무리한다.
