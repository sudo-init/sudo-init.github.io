---
title: '코드로 읽는 Codex 하네스 (2) — 모델을 부르고, 스스로 기억을 줄인다'
slug: codex-harness-agent-loop
category: ai
description: 'run_turn이 호출하는 client.rs와 compact.rs를 열어, Codex가 모델을 어떻게 부르고 컨텍스트가 꽉 찼을 때 무엇을 하는지 실제 코드로 확인했다.'
pubDate: 2026-08-21T11:00:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis', 'context-engineering']
draft: true
---

[1편](/posts/codex-harness-map/)에서 `run_turn`이 "압축 → MCP 서버 선정 →
컨텍스트 캡처 → 모델 호출 → 도구 실행 → 반복"을 오케스트레이션한다는 걸
확인했다. 이번 편에서는 그중 두 조각, **모델 호출**(`client.rs`)과
**컨텍스트 압축**(`compact.rs`)을 연다. 커밋은 지난 편과 같은
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## 모델을 부르는 쪽: 생각보다 훨씬 신경 쓴 통신 계층

`run_turn`의 루프는 매 스텝마다
[`run_sampling_request`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/core/src/session/turn.rs#L1322)를
부른다. 이 함수 자체는 재시도 루프다 — 프롬프트를 만들고, 모델을 부르고,
실패하면 에러 종류를 보고 재시도할지 판단한다.

```rust
Err(err) => match err.details() {
    CodexErrorDetails::ContextWindowExceeded => {
        sess.set_total_tokens_full(&turn_context).await;
        return Err(err);
    }
    CodexErrorDetails::UsageLimitReached(e) => { /* rate limit 갱신 후 반환 */ }
    _ => err,
};
if !err.is_retryable() { return Err(err); }
handle_retryable_response_stream_error(&mut retry_state, /* ... */);
```

컨텍스트 초과와 사용량 제한은 재시도 대상이 아니라 즉시 위로 전파한다.
나머지 에러만 `retry_state`를 갱신하며 백오프 후 재시도한다. 에러 종류별로
분기가 갈리는 이유가 명확하다 — 컨텍스트 초과는 같은 프롬프트를 다시 보내
봐야 똑같이 실패하고(이건 뒤에서 볼 압축이 처리할 문제), 사용량 제한은
기다린다고 풀리는 게 아니기 때문이다.

실제 모델 호출은
[`core/src/client.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/core/src/client.rs)의
`ModelClient`/`ModelClientSession`이 담당한다. 여기서 세 가지가 눈에 띈다.

**1. HTTP SSE와 WebSocket, 두 개의 전송 경로가 공존한다.**
`stream_responses_api`(1440번째 줄, SSE)와 `stream_responses_websocket`(1581번째
줄, WebSocket)이 따로 있고, `responses_websocket_enabled()`로 어느 쪽을 쓸지
고른다. `stream`(1861번째 줄)이 그 위에서 실제로 호출되는 공개 진입점이다.

**2. 같은 턴 안에서는 서버 라우팅을 고정한다.** `ModelClientSession`의
`turn_state` 필드에 대한 주석이 이 설계 의도를 정확히 설명한다.

> `x-codex-turn-state` sticky-routing token, which must be replayed for all
> requests within the same turn ... we receive it at turn start, keep sending
> it unchanged between turn requests (e.g., for retries, incremental appends,
> or continuation requests), and must not send it between different turns.

서버가 턴 시작 시 응답 헤더로 라우팅 토큰을 주면, 그 턴 안의 모든 재시도·증분
요청·이어보내기 요청은 이 토큰을 그대로 실어 보낸다. 백엔드가 여러 대라면
같은 턴의 요청이 중간에 다른 서버로 튀는 걸 막는 장치다. 세션이 끝나면
버려야 한다는 경고까지 주석에 명시돼 있다 — 다음 턴에 재사용하면 라우팅
버그가 난다고.

**3. WebSocket 연결은 재사용하고, 요청은 증분으로 보낸다.**
`WebsocketSession`이 `last_request: Option<ResponsesApiRequest>`를 들고
있다. 주석에 "현재 요청이 이전 요청의 증분 확장일 때만 증분 웹소켓 요청
페이로드를 재사용한다"고 적혀 있다. 대화가 길어질수록 매 스텝마다 전체
히스토리를 다시 통째로 보내는 게 아니라, 이전에 보낸 것과 겹치는 부분은
생략하고 델타만 보낸다는 뜻이다. 컨텍스트가 커질수록 이 최적화가
아끼는 대역폭도 커진다.

## 컨텍스트가 꽉 찼을 때: 압축은 사실 "또 하나의 턴"이다

[지난 글](/posts/harness-engineering/)의 컨텍스트 엔지니어링 부분에서 Anthropic의
write·select·compress·isolate 네 전략을 언급했었다. `compact.rs`가 정확히
compress에 해당하는데, 구현 방식이 예상과 달랐다. 별도의 요약 알고리즘이
아니라, **압축해달라는 요청을 합성해서 모델 자신에게 새 턴으로 보내는
방식**이다.

[`run_inline_auto_compact_task`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/core/src/compact.rs#L111)를
보면 이렇다.

```rust
let prompt = turn_context.config.compact_prompt.as_deref()
    .unwrap_or(SUMMARIZATION_PROMPT).to_string();
let input = vec![UserInput::Text { text: prompt, text_elements: Vec::new() }];
run_compact_task_inner(sess, turn_context, input, /* ... */).await
```

`SUMMARIZATION_PROMPT`는 `prompts/templates/compact/prompt.md`에 실제
텍스트로 들어 있다. 전문을 그대로 옮기면 이렇다.

> You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff
> summary for another LLM that will resume the task.
>
> Include:
> - Current progress and key decisions made
> - Important context, constraints, or user preferences
> - What remains to be done (clear next steps)
> - Any critical data, examples, or references needed to continue
>
> Be concise, structured, and focused on helping the next LLM seamlessly
> continue the work.

이 프롬프트가 "유저 메시지"로 둔갑해서 지금까지의 대화 히스토리 뒤에
붙고, 그대로 `run_turn`과 똑같은 모델 호출 경로를 한 번 더 탄다. 즉
압축은 하네스가 텍스트를 잘라내는 문자열 조작이 아니라, 모델에게 "지금까지
있었던 일을 다음 나에게 인수인계하듯 요약해줘"라고 시키는 **셀프 서브턴**이다.
그렇게 받은 요약은 `SUMMARY_PREFIX`("다른 언어 모델이 이 문제를 풀다가
남긴 요약이다...")로 감싸져 새 히스토리의 시작점이 된다.

압축한다고 모든 걸 지우지도 않는다. `InitialContextInjection` enum에
`BeforeLastUserMessage { .. }`와 `DoNotInject` 두 갈래가 있어서, 상황에
따라 최초 컨텍스트(예: 시스템 프롬프트나 세션 초입에 로드한 정보)를 요약
앞에 다시 끼워 넣을지 말지를 고를 수 있다. 무조건 밀어버리는 게 아니라
뭘 남길지를 호출부가 결정하는 구조다.

### 압축은 네 가지 이유로 트리거된다

`CompactionReason`을 따라가면 이렇다.

| 트리거 시점(`CompactionPhase`) | 이유(`CompactionReason`) | 언제 |
| --- | --- | --- |
| `PreTurn` | `ContextLimit` | 턴 시작 전, 지금까지 쌓인 히스토리가 이미 예산을 넘음 |
| `PreTurn` | `CompHashChanged` | 모델이 바뀌어서 이전 모델의 압축 호환 해시가 안 맞음 |
| `PreTurn` | `ModelDownshift` | 더 작은 컨텍스트 윈도우의 모델로 다운시프트됨 |
| `MidTurn` | `ContextLimit` | 턴 도중 도구 호출 결과가 쌓여 예산을 넘음 |

`CompHashChanged`가 특히 눈에 띈다. 세션 도중 사용자가 모델을 바꾸거나
하네스가 자동으로 다른 모델로 라우팅하면, 이전 모델 기준으로 쌓인 히스토리가
새 모델과 호환되지 않을 수 있다는 걸 하네스가 알고 미리 압축부터 한다.
모델 교체라는, 순수 프롬프트/컨텍스트 레벨에서는 존재하지도 않는 문제를
하네스가 감지하고 처리하는 지점이다.

### 압축도 로컬/원격으로 나뉜다

`run_auto_compact`(`turn.rs`)를 보면 압축 실행 자체도 `provider.capabilities().remote_compaction`
값에 따라 세 갈래로 갈린다.

- `RemoteCompactionSupport::Unsupported` → `run_inline_auto_compact_task` (로컬에서 압축 턴 실행)
- `V1` / `V2` → `run_inline_remote_auto_compact_task[_v2]` (백엔드가 압축을 대신 수행)

압축 자체를 서버로 위임할 수 있다는 뜻이다. 클라이언트가 느린 기기거나,
서버 쪽이 더 나은 압축 모델/정책을 쓸 수 있는 경우를 염두에 둔 설계로
보인다.

### 압축 전후에도 훅이 걸려 있다

`run_compact_task_inner`는 실제 압축 작업 앞뒤로 `run_pre_compact_hooks`,
`run_post_compact_hooks`를 부른다. `PreCompactHookOutcome::Stopped`가
나오면 압축 자체를 취소하고 턴을 중단시킨다. 압축 직전에 지금 히스토리를
외부에 백업하거나, 특정 조건에서 압축을 막는 훅을 사용자가 끼워 넣을 수
있는 지점이다.

## 두 조각을 이어보면

1편에서 "지난 글의 개념이 실제로 어느 파일에 사는가"를 매핑했는데, 이번
편에서 본 두 파일은 지난 글의 컨텍스트 엔지니어링 부분이 말한 것의
구체적인 사례이기도 하다. `client.rs`의 증분 웹소켓 요청과 sticky routing은 "같은 정보를 어떻게
효율적으로, 일관되게 전달할까"의 문제고, `compact.rs`는 "정보가 넘칠 때
무엇을 남기고 무엇을 버릴까"의 문제다. 두 문제 모두 프롬프트 문장으로는
풀리지 않고, 재시도 상태 기계와 서브턴 오케스트레이션이라는 하네스 코드로
풀려 있다.

## 다음 편

`run_sampling_request`가 모델 응답에서 함수 호출(tool call)을 받으면
그다음은 `tools/` crate로 넘어간다. 다음 편에서는 `tool_definition.rs`,
`tool_executor.rs`와 `core/src/tools/`의 `router.rs`, `registry.rs`,
`approvals.rs`를 열어서 모델이 뱉은 함수 호출 하나가 실제 실행으로
이어지는 경로와, 실패했을 때 그 실패를 모델에게 어떻게 되돌려주는지를
본다.
