---
title: '코드로 읽는 Codex 하네스 (1) — 지도 그리기'
description: 'OpenAI가 Apache-2.0으로 공개한 Codex 하네스 소스를 직접 열어, 사용자 입력 한 번이 모델 호출과 툴 실행을 거쳐 응답으로 돌아오기까지의 경로를 실제 코드로 추적했다.'
pubDate: 2026-08-20T15:30:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
draft: true
---

[지난 글](/posts/harness-engineering/)에서 OpenAI가 Codex 하네스를 이렇게
설명한다고 인용했다. "모델과 도구 사이의 에이전트 루프, 실행·권한·상태 관리를
포함하는 시스템." 그때는 이 문장을 그대로 받아 적었다. 이번엔 코드를 열어서
이 문장이 실제로 어디에 대응하는지 하나씩 확인해본다.

[openai/codex](https://github.com/openai/codex)는 Apache-2.0 라이선스로
공개돼 있고, 이 글을 쓰는 시점의 최신 커밋
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)를
기준으로 분석했다.

## 저장소 규모부터

`codex` 하나를 설치하면 터미널에서 도는 CLI 바이너리 하나가 딸려 오지만,
소스는 그렇게 단순하지 않다. 워크스페이스 루트의 `Cargo.toml`을 열면
`members` 배열에 crate가 정확히 **133개** 들어 있다. 이름만 봐도 CLI 하나의
범위를 넘는다.

```
aws-auth, analytics, agent-graph-store, agent-identity, backend-client,
bwrap, app-server, app-server-daemon, app-server-protocol, apply-patch,
cloud-config, cloud-tasks, cloud-tasks-client, code-mode, code-mode-host,
codex-mcp, connectors, exec-server, file-watcher, hooks, keyring-store,
linux-sandbox, mcp-server, network-proxy, otel, rollout, sandboxing,
skills, thread-manager-sample, websocket-client, windows-sandbox-rs, ...
```

`cloud-tasks`, `agent-graph-store`, `network-proxy`처럼 로컬 CLI라는 이미지와
안 맞는 이름도 섞여 있다. 실제로 뒤에서 볼 `exec-server` 쪽에는 원격 실행을
위한 `remote_process`, `remote_file_system`, 암호화 채널을 위한
`noise_channel` 같은 모듈도 있다. 이 시리즈에서는 로컬 CLI로 동작할 때
실제로 밟히는 경로를 중심으로 보되, 이런 확장 지점이 있다는 것 정도는 표시해
두려 한다.

이번 편에서는 전체를 다 훑는 대신, **사용자가 프롬프트를 하나 입력했을 때
그 요청이 어떤 파일들을 거쳐서 다시 응답으로 돌아오는지** 하나의 경로만
끝까지 추적한다. 지도를 먼저 그려야 다음 편부터 각 구역을 깊이 팔 수
있으니까.

## 요청과 응답은 코드에서 뭐라고 부르나

먼저 어휘부터 맞추고 가야 한다. Codex 하네스는 클라이언트(CLI/TUI)와 엔진
사이를 **이벤트 기반**으로 정의해 놓았다.
[`protocol/src/protocol.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/protocol/src/protocol.rs)에
두 개의 큰 enum이 있다.

- **`Op`** (543번째 줄) — 클라이언트가 엔진에 "제출"할 수 있는 것. `TurnInput`
  (턴 시작), `ExecApproval`(명령 실행 승인/거부), `Interrupt`(중단),
  `RecoverTurn`(끊긴 턴 재개), `RealtimeConversationStart` 같은 실시간 음성
  대화 제어까지 한 enum 안에 있다.
- **`EventMsg`** (1289번째 줄) — 엔진이 클라이언트로 스트리밍하는 것.
  `TurnStarted`, `TurnComplete`, `ContextCompacted`(컨텍스트가 압축됨),
  `ThreadRolledBack`(사용자 턴 롤백), `GuardianWarning`(자동 승인 검토기
  경고) 등이 있다.

재미있는 디테일이 하나 있다. `TurnComplete` 항목에는 이런 주석이 붙어 있다.

```rust
/// Agent has completed all actions.
/// v1 wire format uses `task_complete`; accept `turn_complete` for v2 interop.
#[serde(rename = "task_complete", alias = "turn_complete")]
TurnComplete(TurnCompleteEvent),
```

와이어 포맷을 `task_complete`에서 `turn_complete`로 바꾸는 중인데, 옛날
클라이언트가 아직 `task_complete`를 기대하니 직렬화는 옛 이름으로 하고
역직렬화는 두 이름 다 받는다. 실제로 여러 클라이언트(앱서버, TUI, VS Code
확장, 데스크톱 앱)가 같은 프로토콜을 공유하며 계속 진화하고 있다는 뜻이다.
장난감 프로젝트에서는 잘 안 보이는 종류의 흔적이다.

## 한 턴이 실제로 밟는 경로

이 `Op`/`EventMsg`를 실제로 소비하고 만들어내는 곳이
[`core/src/session/turn.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/core/src/session/turn.rs)의
`run_turn` 함수다(153번째 줄). `TurnInput`이 들어오면 이 함수가 턴 하나를
끝까지 책임진다. 코드를 그대로 따라가 보면 순서가 이렇다.

1. **턴 시작 전 압축** — `run_pre_sampling_compact`를 먼저 돌린다. 새 입력을
   기록하기 전에, 지금까지 쌓인 히스토리가 임계값을 넘었으면 먼저
   압축한다. (이 압축 로직 자체는 `core/src/compact.rs`에 있고, 다음 편에서
   따로 다룬다.)
2. **이번 턴에 필요한 MCP 서버 계산** — `required_mcp_servers_for_input`으로
   사용자 입력을 보고 어떤 MCP 서버가 필요한지 먼저 판단한다. 모든 MCP
   서버를 항상 켜놓는 게 아니라 턴마다 필요한 것만 골라 붙인다.
3. **스텝 컨텍스트 캡처** — `capture_step_context_with_required_mcp_servers`가
   이번 요청에 쓸 모델 정보, 도구 목록, world state를 하나로 묶는다. 주석에
   "컨텍스트, 광고할 도구, 툴 콜이 하나의 요청 뷰를 공유하도록 한 번만
   캡처한다"고 적혀 있다 — 같은 턴 안에서 도구 목록이 요청 중간에 바뀌는
   불일치를 막으려는 설계다.
4. **스킬/플러그인 주입, 훅 실행** — `build_skills_and_plugins`로 스킬과
   플러그인을 주입한 뒤, `run_pending_session_start_hooks`로 대기 중인
   세션 시작 훅을 실행하고, `run_hooks_and_record_inputs`로 이번 턴의
   입력을 기록하며 훅을 한 번 더 돌린다.
5. **메인 루프** — 여기서부터 `loop { ... }`다. 매 반복마다:
   - 큐에 쌓인 **대기 입력**(pending_input)을 확인한다. 코드 주석이 이
     의도를 잘 설명한다 — "모델이 도는 동안 사용자가 UI로 보낸 메시지"를
     가리킨다. 즉 모델이 응답을 만드는 도중에도 사용자가 새 메시지를 보낼
     수 있고, 그 입력은 버려지지 않고 큐에 쌓였다가 다음 반복에서
     반영된다.
   - `capture_step_context`로 이번 스텝의 컨텍스트를 다시 잡는다.
   - `run_sampling_request`를 호출해 실제로 모델을 부른다 (`client.rs`가
     이 호출을 담당하고, 이것도 다음 편 주제다).
   - 응답에 함수 호출(tool call)이 있으면 실행하고 결과를 히스토리에
     추가한 뒤 다시 루프를 돈다. 없으면 `TurnComplete`를 내보내고 끝낸다.

정리하면 `run_turn` 하나가 "압축 → MCP 서버 선정 → 컨텍스트 캡처 → 모델 호출
→ 도구 실행 → 반복"을 전부 오케스트레이션하는 자리다. 지난 글에서 뭉뚱그려
"에이전트 루프"라고 불렀던 것의 실체가 이 함수다.

## 지난 글의 개념과 실제 코드 대응표

[지난 글](/posts/harness-engineering/)에서 다룬 개념들이 실제로 어느 파일에
사는지 정리하면 이렇다.

| 지난 글에서 다룬 개념 | 실제 코드 |
| --- | --- |
| 에이전트 루프 | `core/src/session/turn.rs`의 `run_turn` |
| 모델 호출 | `core/src/client.rs` |
| 컨텍스트 압축(하네스가 스스로 수행) | `core/src/compact.rs`, `run_pre_sampling_compact` |
| 도구 정의·검색·실행 | `tools/` crate 전체 (`tool_definition.rs`, `tool_executor.rs`, `mcp_tool.rs`) |
| 파일 수정 전용 도구 | `apply-patch/` crate |
| 명령 실행 | `exec-server/`, `core/src/exec.rs` |
| 실행 격리(샌드박스) | `sandboxing/`, `linux-sandbox/`, `windows-sandbox-rs/` |
| 권한/승인 정책 | `protocol/src/permissions.rs` (3,634줄) |
| 요청/응답 프로토콜 | `protocol/src/protocol.rs`의 `Op`/`EventMsg` |
| 세션 기록·재개 | `core/src/rollout.rs`, `rollout/` crate |
| 훅 | `core/src/hook_runtime.rs`, `hooks/` crate |

지난 글에서 "이 네 가지의 공통점은 전부 모델이 그 순간 뭐라고 판단하든
상관없이 작동한다는 것"이라고 썼는데, `run_turn`의 5단계 구조를 보면 그 말이 그대로
코드 구조다. 모델이 무슨 응답을 하든 압축 시점·MCP 서버 선정·컨텍스트
캡처 순서는 하네스가 고정해 놓았고, 모델은 그 틀 안에서 텍스트나 함수
호출을 뱉을 뿐이다.

## 다음 편

이번 편은 지도만 그렸다. 다음 편에서는 `run_turn`이 호출하는
`run_sampling_request`와 `client.rs`를 열어서, 모델 API를 실제로 어떻게
부르고 스트리밍 응답을 어떻게 받아 히스토리에 쌓는지, 그리고
`run_pre_sampling_compact`가 정확히 언제 압축을 트리거하는지를 본다.
