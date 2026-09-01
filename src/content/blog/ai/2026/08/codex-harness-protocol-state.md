---
title: '코드로 읽는 Codex 하네스 (6) — 기록하고, 다시 접속한다'
slug: codex-harness-protocol-state
category: ai
description: '시리즈 마지막 편. rollout과 mcp-server/codex-mcp를 열어, Codex가 세션을 어떻게 두 가지 형태로 저장하고 MCP를 클라이언트이자 서버로 동시에 쓰는지 확인하며 여섯 편을 마무리했다.'
pubDate: 2026-08-21T21:30:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
---

[1편](/posts/codex-harness-map/)에서 지도를 그리고, [2편](/posts/codex-harness-agent-loop/)에서
모델 호출과 압축을, [3편](/posts/codex-harness-tool-system/)에서 도구
실행을, [4편](/posts/codex-harness-apply-patch/)에서 파일 수정을,
[5편](/posts/codex-harness-sandbox/)에서 실행 격리를 봤다. 마지막 편은
이 모든 걸 감싸는 두 층 — **세션을 어떻게 기록하는가**, 그리고
**Codex가 다른 도구/에이전트와 어떻게 접속하는가** — 를 열고 시리즈를
마무리한다. 커밋은 계속 같은
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## 세션은 두 가지 형태로 동시에 저장된다

`rollout/` crate를 열면 저장 방식이 하나가 아니라는 게 바로 보인다.

- **`recorder.rs`** — 모듈 첫 줄 주석 그대로다. "Persist Codex session
  rollouts (.jsonl) so sessions can be replayed or inspected later." 턴마다
  일어난 일을 JSON Lines로 이어붙이는, 추가만 되는(append-only) 원본
  로그다.
- **`state_db.rs`** — "Core-facing handle to the SQLite-backed state
  runtime." 세션을 나열하거나 검색할 때(`list.rs`의 `Cursor`,
  `ThreadSortKey`) 매번 `.jsonl` 파일을 처음부터 파싱하는 대신, SQLite에
  인덱싱된 메타데이터를 조회한다.

왜 굳이 둘로 나눴을까. `.jsonl`은 "이 세션에 실제로 무슨 일이 있었는지"를
빠짐없이 재현하기 위한 진실의 원천(source of truth)이고, SQLite는 "세션
수백 개 중에 뭘 다시 열지" 같은 질의를 빠르게 하기 위한 인덱스다. 재현
정확도와 조회 속도, 서로 다른 두 요구를 하나의 저장 방식으로 만족시키려
하지 않고 아예 분리해버린 구조다.

여기서 이름이 헷갈리기 쉬운 지점이 하나 있다. `compression.rs`는 오래된
`.jsonl` 로그 파일을 `.zst`(zstd)로 압축해서 디스크 용량을 줄이는
모듈이다. [2편](/posts/codex-harness-agent-loop/)에서 다룬 "컨텍스트
압축"(`compact.rs`, 모델에게 요약을 시키는 것)과는 완전히 다른 층이다.
전자는 **디스크에 쌓인 로그 파일 크기**를 줄이는 문제고, 후자는 **모델에게
매번 보내는 프롬프트 크기**를 줄이는 문제다. 둘 다 "압축"이라 불리지만
겹치는 코드가 하나도 없다.

## 프로토콜은 누구와 누구 사이의 계약인가

1편에서 `Op`/`EventMsg`를 봤을 때는 "클라이언트와 엔진 사이"라고
뭉뚱그렸는데, 실제로 그 클라이언트 자리에 오는 게 뭔지는
[`app-server/`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/app-server/src)를
보면 분명해진다. `message_processor.rs`, `transport.rs`,
`outgoing_message.rs`, `request_processors/`로 구성된 이 crate가 TUI,
VS Code 확장, 데스크톱 앱이 공통으로 붙는 JSON-RPC 서버다. `fs_watch.rs`,
`fuzzy_file_search.rs`, `code_mode_host.rs`처럼 UI를 지원하기 위한
부가 기능도 여기 산다. 즉 `Op`/`EventMsg`는 "1인칭 클라이언트"용 계약이고,
이 계약을 실제로 주고받는 서버가 app-server다.

## Codex는 MCP를 양쪽에서 다 쓴다

여기가 이번 편에서 가장 흥미로운 지점이다. Model Context Protocol을 Codex는
**클라이언트로도 서버로도** 쓴다.

**클라이언트 쪽**은 `codex-mcp/` crate다. `connection_manager.rs`가 외부
MCP 서버들과의 연결을 관리하고, `catalog.rs`/`tool_catalog_cache.rs`가
그 서버들이 제공하는 도구 목록을 캐시하고, `rmcp_client.rs`가 실제 MCP
클라이언트 구현이다. 2편에서 본 "이번 턴에 필요한 MCP 서버만 골라
붙인다"는 로직이 여기로 이어진다.

**서버 쪽**은 `mcp-server/` crate다. `lib.rs` 첫 줄이 스스로를 이렇게
소개한다.

```rust
//! Prototype MCP server.
```

`rmcp` 크레이트(러스트 MCP SDK)의 `ClientRequest`, `ClientNotification`,
`JsonRpcMessage`를 갖다 써서 stdin/stdout으로 JSON-RPC를 주고받는다.
`codex_tool_runner.rs`, `exec_approval.rs`, `patch_approval.rs`가 있는
걸 보면, 이 서버가 노출하는 도구는 "Codex 세션 하나를 통째로 실행하고
승인 흐름까지 처리하는" 상당히 두꺼운 도구다. 다시 말해 Claude Code 같은
다른 에이전트가 MCP로 Codex를 서브에이전트처럼 불러 쓸 수 있다는 뜻이다.
[3편](/posts/codex-harness-tool-system/)에서 본 `mcp`/`mcp_resource`
도구가 "Codex가 남의 MCP 서버를 소비하는" 경로였다면, 이 crate는 정반대
방향 — "Codex 자신이 남의 MCP 클라이언트에게 소비되는" 경로다. 코드
주석에 여전히 "Prototype"이라고 적혀 있는 걸 보면, 이 양방향 구조가 아직도
활발히 다듬어지는 중이라는 것도 짐작할 수 있다.

## 여섯 편을 한 표로

이 시리즈에서 연 파일들을,
[지난 글](/posts/harness-engineering/)에서 인용했던 OpenAI의
설명 — "모델과 도구 사이의 에이전트 루프, 실행·권한·상태 관리를 포함하는
시스템" — 에 최종적으로 맞춰보면 이렇다.

| 개념 | 담당 코드 | 다룬 편 |
| --- | --- | --- |
| 에이전트 루프 | `session/turn.rs`의 `run_turn` | 1편 |
| 모델 호출 | `client.rs` (SSE/WebSocket, sticky routing) | 2편 |
| 컨텍스트 관리 | `compact.rs` (셀프 서브턴으로 요약) | 2편 |
| 도구 정의·노출 | `tools/`, `ToolExposures` | 3편 |
| 도구 실행·승인 | `core/src/tools/`, `approvals.rs`, Guardian | 3편 |
| 파일 수정 | `apply-patch/` (전용 포맷, 퍼지 매칭) | 4편 |
| 실행 격리 | `sandboxing/`, OS별 3중 구현 | 5편 |
| 세션 기록 | `rollout/`(`.jsonl` + SQLite 이중 저장) | 6편 |
| 외부 연동(양방향) | `codex-mcp`(클라이언트) / `mcp-server`(서버) | 6편 |

## 시리즈를 마치며

[1편](/posts/codex-harness-map/)을 시작할 때 목표는 "지난 글에서 인용만
하고 넘어갔던 문장이 실제로 코드로 존재하는지 확인한다"였다. 여섯 편을
거치면서 확인한 건, 그 문장 하나하나가 축약이 아니라 오히려 압축이었다는
것이다. "에이전트 루프" 한 단어 안에 사전 압축·MCP 서버 선정·컨텍스트
캡처·훅 실행이 순서대로 들어 있었고, "권한 관리" 한 단어 안에 OS 세 개가
서로 다른 프리미티브로 구현한 샌드박스와 `.git/hooks`를 콕 집어 막는
방어까지 들어 있었다. 하네스 엔지니어링이 마케팅 용어가 아니라 실제로
133개 crate 분량의 코드로 존재한다는 걸, 이번 시리즈로 직접 확인한
셈이다.
