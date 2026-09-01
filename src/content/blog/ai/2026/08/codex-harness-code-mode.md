---
title: '코드로 읽는 Codex 하네스 (8) — 함수 호출 대신 스크립트를 쓰게 한다'
slug: codex-harness-code-mode
category: ai
description: 'code-mode 관련 크레이트 네 개와 v8-poc를 열어, Codex가 매 턴 함수 하나씩 부르는 대신 V8 격리 환경에서 스크립트로 여러 도구를 한 번에 오케스트레이션하게 만든 구조를 코드로 확인했다.'
pubDate: 2026-08-22T13:00:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
---

[7편](/posts/codex-harness-exec-policy/)에서 어떤 명령을 사람에게 묻지 않고
실행할지 정하는 로직을 봤다. 3편에서 도구 목록을 훑을 때 `code_mode`라는
모듈이 있다는 것만 확인하고 지나갔는데, 이번 편에서 연다. 커밋은 이
시리즈에서 계속 쓰는
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## `v8-poc`는 함정이었다

1편에서 워크스페이스를 훑을 때 `v8-poc`라는 crate 이름을 보고 "이게
Code Mode의 실행 엔진이겠구나" 짐작했다. 열어보니 아니었다. 파일 첫
줄이 이렇다.

```rust
//! Bazel-wired proof-of-concept crate reserved for future V8 experiments.
```

`bazel_target()`, `embedded_v8_version()`, 정수 덧셈과 문자열 연결을
평가해 보는 테스트 몇 개가 전부다. **미래에 쓸 실험용으로 남겨둔 crate**라고
스스로 밝히고 있다. 진짜 구현은 다른 곳, `code-mode-runtime`에 있었다.

## `exec` 하나로 여러 도구를 오케스트레이션한다

Code Mode의 정체는
[`code-mode-protocol/src/lib.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/code-mode-protocol/src/lib.rs#L50)의
상수 하나로 요약된다.

```rust
pub const PUBLIC_TOOL_NAME: &str = "exec";
```

모델에게 도구를 하나씩 여러 개 주는 대신, `exec`라는 도구 하나만 주고
그 안에서 JavaScript를 쓰게 한다. 실제로 모델에게 보여주는 설명 텍스트가
[`description.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/code-mode-protocol/src/description.rs#L15)의
`EXEC_DESCRIPTION_TEMPLATE`에 그대로 있다. 일부를 그대로 옮기면 이렇다.

> Run JavaScript code to orchestrate/compose tool calls
> - Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.
> - All nested tools are available on the global `tools` object, for example
>   `await tools.exec_command(...)`. Tool names are exposed as normalized
>   JavaScript identifiers, for example `await tools.mcp__ologs__get_profile(...)`.
> - Runs raw JavaScript -- no Node, no file system, no network access, no console.
> - Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.

3편에서 본 도구들이 전부 `tools.도구이름(...)` 형태로 이 JS 안에 들어온다.
MCP 도구 이름의 `__` 구분자(`mcp__ologs__get_profile`)까지 그대로
노출된다. 모델은 매 스텝 함수 호출 하나를 뱉는 대신, 여러 도구 호출을
포함한 스크립트 하나를 한 번에 짜서 보낼 수 있다 — 도구 A의 결과를 보고
바로 도구 B를 부르는 분기 로직까지 JS 코드로 표현할 수 있다는 뜻이다.

## 격리: Node도, 파일시스템도, 네트워크도 없다

위 설명에서 가장 중요한 줄은 "no Node, no file system, no network access,
no console"이다. 이 스크립트가 바깥 세계와 접촉할 수 있는 유일한 통로는
`tools` 객체뿐이다. `require`나 `fetch`, `fs.readFile` 같은 건 애초에
전역에 없다.

실행 엔진은
[`code-mode-runtime/src/v8_init.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/code-mode-runtime/src/v8_init.rs)에
있다. 여기서 한 가지 더 눈에 띈다. V8의 JIT 컴파일 자체를 끌 수 있다.

```rust
pub enum V8JitMode {
    #[default]
    Enabled,
    Disabled,
}
```

`Disabled`를 고르면 `--jitless` 플래그로 V8을 초기화한다. JIT는 실행
속도를 크게 높여주지만, JIT 스프레이나 타입 컨퓨전 같은 V8 취약점의
상당수가 JIT 컴파일 경로에서 나온다. 신뢰할 수 없는 코드(모델이 방금
짠 스크립트)를 돌려야 하는 상황에서는 속도를 내주고 공격 표면을 줄이는
쪽을 선택할 수 있게 만들어 둔 것이다. 이런 값은 한 번 정하면 프로세스
생애 동안 못 바꾼다 — 주석에 "V8 cannot change JIT mode after
initialization"이라고 명시돼 있다.

## 오래 걸리는 스크립트는 `wait`로 이어받는다

스크립트가 오래 걸리면 어떻게 될까. `exec`는 실행이 안 끝나면 "Script
running with cell ID ..."를 돌려주고, 그 뒤로는 `wait`라는 또 다른 도구가
이어받는다. `WAIT_DESCRIPTION_TEMPLATE`을 보면 이렇다.

> - Use `wait` only after `exec` returns `Script running with cell ID ...`.
> - `cell_id` identifies the running `exec` cell to resume.
> - `yield_time_ms` controls how long to wait for more output before yielding again.
> - `terminate: true` stops the running cell; false or omitted waits for output.

"cell"이라는 단어 선택이 힌트다. `code-mode-runtime`에 `cell_actor/`라는
모듈이 따로 있고, `code-mode-protocol`에는 `CellId`, `StartedCell`
타입이 있다 — 주피터 노트북의 셀처럼, 스크립트 실행 하나하나를 독립된
단위로 다루면서 그 상태(진행 중/완료/타임아웃)를 계속 추적한다는 뜻이다.
스크립트 안에서 `yield_control()`을 부르면 아직 실행 중이어도 지금까지
쌓인 출력을 모델에게 먼저 넘겨줄 수도 있다 — 긴 작업의 중간 경과를
스트리밍하는 셈이다.

## 세션 사이에 상태를 들고 다닌다

`exec` 호출은 각각 "fresh V8 isolate"라고 했는데, 그러면 이전 `exec`
호출에서 계산한 값은 다음 호출에서 사라져야 정상이다. 그런데 전역 헬퍼로
`store`/`load`가 있다.

> - `store(key: string, value: any)`: stores a serializable value under a
>   string key for later `exec` calls in the same session.
> - `load(key: string)`: returns the stored value for a string key, or
>   `undefined` if it is missing.

isolate 자체는 매번 새로 만들지만, 세션 스코프의 키-값 저장소를 통해
직렬화 가능한 값은 다음 `exec` 호출로 넘길 수 있다. 격리(매번 새 isolate)와
연속성(세션 안에서는 계속 이어지는 작업)을 동시에 만족시키는 절충안이다.

## 별도 프로세스로도 뺄 수 있다

`code-mode-runtime`에는 `InProcessCodeModeSession`이 있어서 V8을 codex-core
프로세스 안에서 직접 돌릴 수 있다. 그런데 `code-mode-host`라는 crate가
따로 있고, 이건 이름 그대로 **별도 프로세스로 V8 세션을 호스팅**하는
쪽이다. `HostHello`, `ProtocolVersion`, `SupportedProtocolVersions`,
`DUAL_WEBSOCKET_CAPABILITY` 같은 타입들을 보면 WebSocket 기반의 핸드셰이크
프로토콜로 codex-core와 통신한다.

굳이 프로세스를 분리하는 이유는 짐작하기 어렵지 않다. V8 isolate가 격리를
제공한다고 해도, isolate 탈출 취약점이 아예 없다고 보장할 수는 없다.
프로세스 경계를 하나 더 두면, isolate가 뚫려도 [5편](/posts/codex-harness-sandbox/)에서
본 OS 샌드박스가 여전히 그 프로세스를 가둔 채로 있다 — 방어선을 하나
더 세우는 구조다.

## 정리

| 질문 | 담당 코드 |
| --- | --- |
| 실행 엔진은 뭘 쓰나 | `code-mode-runtime`의 V8(`v8_init.rs`), `v8-poc`는 미사용 실험 crate |
| 모델에게 뭘 보여주나 | `exec`/`wait` 도구, `EXEC_DESCRIPTION_TEMPLATE` |
| 도구 호출은 어떻게 하나 | 전역 `tools.도구이름(...)` 객체 |
| 격리는 어떻게 하나 | fresh V8 isolate, Node/fs/네트워크/console 없음, `--jitless` 옵션 |
| 오래 걸리는 실행은 | `cell_actor`의 cell 단위 추적, `wait`로 이어받기, `yield_control()` |
| 세션 간 상태 | `store`/`load` 키-값 저장소 |
| 추가 격리 | `code-mode-host`로 별도 프로세스 분리(WebSocket 프로토콜) |

## 다음 편

3편에서 `multi_agents`/`multi_agents_v2` 도구가 `spawn_agent`,
`send_message`, `followup_task`를 노출한다는 것만 짚고 넘어갔다. 다음
편에서는 `agent-graph-store`, `agent-identity` crate를 열어서, 서브
에이전트를 띄우고 서로 통신하게 만드는 멀티 에이전트 오케스트레이션이
실제로 어떻게 구현돼 있는지 본다.
