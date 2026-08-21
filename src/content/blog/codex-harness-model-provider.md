---
title: '코드로 읽는 Codex 하네스 (10) — OpenAI 없이도 켜진다'
description: 'model-provider와 ollama/lmstudio 크레이트를 열어, ModelClient가 OpenAI뿐 아니라 Amazon Bedrock과 로컬 모델까지 같은 인터페이스로 추상화하는 방식을 코드로 확인했다.'
pubDate: 2026-08-22T17:00:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
draft: true
---

[2편](/posts/codex-harness-agent-loop/)에서 `ModelClient`를 열었을 때는
OpenAI Responses API만 상대하는 걸로 봤다. 그런데 워크스페이스 목록에는
`lmstudio`, `ollama`라는 crate도 있었다. 이번 편에서 그 프로바이더
추상화 계층을 연다. 커밋은 이 시리즈에서 계속 쓰는
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## 프로바이더는 두 곳에서 정의된다

[`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/model-provider-info/src/lib.rs)
첫 줄이 이 crate의 역할을 요약한다.

> Providers can be defined in two places:
> 1. Built-in defaults compiled into the binary so Codex works out-of-the-box.
> 2. User-defined entries inside `~/.codex/config.toml` under the
>    `model_providers` key. These override or extend the defaults at runtime.

바이너리에 내장된 기본 프로바이더 목록이 있고, 그 위에 사용자가
`config.toml`로 새 프로바이더를 추가하거나 기존 걸 덮어쓸 수 있다.

## OpenAI만 있는 게 아니다

내장 상수들을 보면 지원 범위가 넓다.

```rust
const OPENAI_PROVIDER_NAME: &str = "OpenAI";
pub const CHATGPT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const AMAZON_BEDROCK_PROVIDER_NAME: &str = "Amazon Bedrock";
pub const AMAZON_BEDROCK_GPT_5_5_MODEL_ID: &str = "openai.gpt-5.5";
pub const AMAZON_BEDROCK_DEFAULT_BASE_URL: &str =
    "https://bedrock-mantle.us-east-1.api.aws/openai/v1";
```

Amazon Bedrock을 통해 GPT 계열 모델을 부르는 경로가 따로 있다. 요청
헤더에도 `x-amzn-mantle-client-agent: codex`가 붙는다 — Bedrock 게이트웨이
쪽에 "이 요청은 Codex에서 왔다"는 걸 알려주는 용도로 보인다.
`model-provider/src/provider.rs`의 import 목록에는
`is_azure_responses_provider`도 있어서, Azure OpenAI Service 경로도
별도로 처리하고 있다는 걸 짐작할 수 있다.

## 로컬 모델도 1급 시민이다

`ollama/src/lib.rs`와 `lmstudio/src/lib.rs`는 구조가 거의 같다. 둘 다
`ensure_oss_ready`라는 함수가 있고, 로컬 서버가 살아 있는지 확인한 뒤
모델이 없으면 자동으로 받아온다.

```rust
// ollama/src/lib.rs
pub const DEFAULT_OSS_MODEL: &str = "gpt-oss:20b";

// lmstudio/src/lib.rs
pub const DEFAULT_OSS_MODEL: &str = "openai/gpt-oss-20b";
```

`--oss` 플래그를 주고 모델을 따로 지정하지 않으면 둘 다 `gpt-oss`로
떨어진다. 공교롭게도 이건 `openai` 조직이 공개한 또 다른 저장소 이름과
같다 — OpenAI가 공개한 오픈 웨이트 모델 `gpt-oss-20b`다. Codex 하네스
자체는 오픈소스로 공개하고, 로컬로 붙일
기본 모델도 자기네가 공개한 오픈 웨이트 모델을 기본값으로 잡아 둔
셈이다. `ensure_oss_ready`는 로컬에 그 모델이 없으면 `fetch_models`로
확인하고 없으면 바로 받아온다 — 사용자가 별도로 `ollama pull`을 먼저
안 해도 되게 만든 온보딩 경로다.

## 폐기된 경로에도 흔적이 남는다

이 계층에서 눈에 띈 또 다른 점은, 오래된 설정을 그냥 무시하지 않고
정확히 어떻게 고쳐야 하는지 알려주고 실패시킨다는 것이다.

```rust
const CHAT_WIRE_API_REMOVED_ERROR: &str =
    "`wire_api = \"chat\"` is no longer supported.\n\
     How to fix: set `wire_api = \"responses\"` in your provider config.\n\
     More info: https://github.com/openai/codex/discussions/7782";

pub const OLLAMA_CHAT_PROVIDER_REMOVED_ERROR: &str =
    "`ollama-chat` is no longer supported.\n\
     How to fix: replace `ollama-chat` with `ollama` in `model_provider`...";
```

실제로 `WireApi` enum을 열어보면 지금은 `Responses` 배리언트 하나만
남아 있다 — Chat Completions 스타일의 옛 와이어 프로토콜은 완전히
제거됐다. 코드에서 지워버리는 대신, 옛 설정 파일을 쓰는 사용자가
"왜 안 되지"에서 멈추지 않도록 정확한 수정 방법과 GitHub 디스커션
링크까지 에러 메시지에 박아 뒀다.

## 2편에서 본 압축 지원, 사실 여기 있었다

2편에서 `turn_context.provider.capabilities().remote_compaction`이
`RemoteCompactionSupport::Unsupported`/`V1`/`V2`로 갈린다고 짚었는데,
정작 이 enum이 사는 곳은 확인하지 않았었다. 실제로는 바로 이
[`model-provider/src/provider.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/model-provider/src/provider.rs)에
정의돼 있다.

```rust
pub enum RemoteCompactionSupport {
    Unsupported,
    V1,
    V2,
}
```

왜 프로바이더 crate에 이 값이 있는지는 이제 명확하다 — 원격 압축은
백엔드가 그 프로토콜을 지원해야 가능한 기능인데, 어떤 백엔드를 쓰느냐가
바로 이 crate가 추상화하는 대상이다. OpenAI 백엔드는 `/v1/responses/compact`
전용 엔드포인트나 `compaction_trigger` 아이템을 지원하지만, 로컬
Ollama/LM Studio 서버는 당연히 그런 원격 압축 프로토콜이 없다 —
`Unsupported`로 떨어지고, 압축은 로컬에서 셀프 서브턴으로 처리된다.
프로바이더가 뭐냐에 따라 하네스의 다른 부분(컨텍스트 관리)까지 갈라지는
지점이다.

## 정리

| 질문 | 담당 코드 |
| --- | --- |
| 프로바이더는 어디서 정의되나 | 내장 기본값 + `~/.codex/config.toml`의 `model_providers` |
| OpenAI 말고 뭘 지원하나 | Amazon Bedrock, (흔적상) Azure OpenAI |
| 로컬 모델은 어떻게 붙나 | `ollama`/`lmstudio` crate, `--oss` 플래그, `ensure_oss_ready` |
| 로컬 기본 모델은 뭔가 | `gpt-oss-20b`(OpenAI 자체 오픈 웨이트 모델) |
| 폐기된 설정은 어떻게 처리하나 | 명시적 에러 메시지 + 수정 방법 + 디스커션 링크 |
| 압축 지원이 프로바이더별인 이유 | 원격 압축은 백엔드 프로토콜 지원 여부에 달려 있음 |

## 다음 편

이 시리즈 내내 `run_pre_tool_use_hooks`, `run_pre_compact_hooks`,
`run_pending_session_start_hooks`처럼 훅을 계속 인용만 하고 실제로
훅이 뭔지는 한 번도 안 열어봤다. 다음 편에서는 `hooks/` crate를 열어서
사용자가 실제로 훅을 어떻게 등록하고 설정하는지 본다.
