---
title: '코드로 읽는 Codex 하네스 (9) — 에이전트가 에이전트를 부른다'
description: 'agent-graph-store와 agent-identity를 열어, Codex가 서브에이전트의 부모-자식 관계를 그래프로 추적하고 암호학적 신원까지 부여하는 멀티 에이전트 오케스트레이션 구조를 코드로 확인했다.'
pubDate: 2026-08-22T15:30:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
draft: true
---

[3편](/posts/codex-harness-tool-system/)에서 `multi_agents`/`multi_agents_v2`
도구가 `spawn_agent`, `send_message`, `followup_task`를 노출한다는 것만
짚고 넘어갔다. 이번 편에서 그 뒤에 있는 오케스트레이션 구조를 연다.
커밋은 이 시리즈에서 계속 쓰는
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## 부모-자식 관계는 그래프로 저장된다

`agent-graph-store` crate는 이름 그대로 그래프 저장소다.
[`types.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/agent-graph-store/src/types.rs)에
`ThreadSpawnEdgeStatus`(`Open`/`Closed`)가 있고, `store.rs`의
`AgentGraphStore` 트레이트는 이런 메서드를 요구한다.

```rust
fn upsert_thread_spawn_edge(&self, parent_thread_id, child_thread_id, status);
fn set_thread_spawn_edge_status(&self, child_thread_id, status);
fn list_thread_spawn_children(&self, parent_thread_id, status_filter);
```

주석에 "List spawned descendants breadth-first by depth, then by thread id"라는
메서드도 있다. 서브 에이전트를 하나 띄우면 그게 끝이 아니라, 그 서브
에이전트가 또 다른 서브 에이전트를 띄울 수 있고, 그 전체 계보를 방향성
있는 그래프(부모→자식 엣지)로 영속화해서 나중에 깊이 우선/너비 우선으로
순회할 수 있게 만들어 뒀다. `spawn_agent` 도구 호출 하나가 실제로는
그래프에 노드 하나와 엣지 하나를 추가하는 일이다.

## 서브에이전트도 암호학적 신원이 있다

`agent-identity` crate를 열었을 때 가장 놀랐던 부분이다. 단순히 이름
문자열로 에이전트를 구분하는 게 아니었다. import 목록에 이런 게 있다.

```rust
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use crypto_box::SecretKey as Curve25519SecretKey;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::decode;
```

Ed25519 서명 키, Curve25519 비밀 키, JWT를 JWKS(JSON Web Key Set)로
검증하는 로직까지 들어 있다. `AGENT_IDENTITY_JWT_AUDIENCE`는
`"codex-app-server"`로 고정돼 있다. 서브 에이전트가 자기 자신을 증명할
때 이름표가 아니라 서명된 토큰을 쓴다는 뜻이다. 여러 에이전트가 동시에
돌면서 서로 메시지를 주고받는 상황에서, "이 메시지가 정말 그 에이전트가
보낸 게 맞는지"를 암호학적으로 보장하려는 설계로 보인다.

## 역할은 TOML 파일로 정의된다

`core/src/agent/builtins/`에는 내장 에이전트 역할이 TOML로 들어 있다.
`awaiter.toml`을 열어보면 이렇다.

```toml
background_terminal_max_timeout = 3600000
model_reasoning_effort = "low"
developer_instructions="""You are an awaiter.
Your role is to await the completion of a specific command or task and report its status only when it is finished.
...
```

이 역할의 지침이 흥미롭다.

> 2. You must NOT:
>    - Modify the task.
>    - Interpret or optimize the task.
>    - Perform unrelated actions.
>    - Stop awaiting unless explicitly instructed.
> ...
> - Do not hallucinate completion.
> - Use long timeouts when awaiting for something. If you need multiple
>   awaits, increase the timeouts/yield times exponentially.

"awaiter"라는 이름 그대로, 오래 걸리는 작업을 기다리기만 하는 전용
서브 에이전트다. [8편](/posts/codex-harness-code-mode/)에서 본 Code
Mode의 `wait`/`cell` 개념과 결이 같다 — 폴링을 반복하되 완료를 지어내지
말고, 타임아웃을 지수적으로 늘리라는 지침까지 박혀 있다. 참고로 같은
디렉터리의 `explorer.toml`은 이 글을 쓰는 시점 기준 빈 파일이다 —
이름만 예약돼 있고 아직 채워지지 않은 역할로 보인다.

## 권한은 좁아지기만 한다

`role.rs` 파일 맨 위 주석이 이 시스템 전체의 보안 원칙을 한 문장으로
요약한다.

> Roles may customize the child or reduce its capabilities, but never
> replace the parent session's authority.

역할(role)은 자식 에이전트의 동작을 커스터마이즈하거나 권한을 줄일 수는
있어도, 부모 세션이 가진 권한을 넘어설 수는 없다. [5편](/posts/codex-harness-sandbox/)에서
본 "워크스페이스 쓰기 허용 안에서도 `.git/hooks`는 못 건드리게 막아
둔다"는 원칙과 같은 방향이다 — 하위 단위가 상위 단위의 권한을 스스로
넓히는 경로를 아예 코드로 차단해 둔다.

## 이름은 철학자와 과학자에서 따온다

가벼운 디테일 하나. `core/src/agent/agent_names.txt`에 서브 에이전트
닉네임 후보 101개가 줄 단위로 들어 있다.

```
Euclid
Archimedes
Ptolemy
Hypatia
Avicenna
Averroes
Aquinas
Copernicus
Kepler
Galileo
```

`spawn.rs`의 `agent_nickname_candidates`가 역할별로 설정된 이름 후보가
없으면 이 목록에서 골라 쓴다. Docker 컨테이너의 랜덤 이름 같은 역할을
하는데, 형용사+명사 조합 대신 철학자·과학자 이름을 쓴 것도 나름의
취향이다.

## 스폰 입력도 두 갈래다

`spawn.rs`의 `SpawnInitialInput` enum을 보면 서브 에이전트가 시작할 때
받는 입력이 두 종류로 나뉜다.

```rust
enum SpawnInitialInput {
    UserInput(Vec<UserInput>),
    InterAgentCommunication(InterAgentCommunication, AgentCommunicationContext),
}
```

`InterAgentCommunication`은 [1편](/posts/codex-harness-map/)에서 본
`Op` enum에도 있던 변형 중 하나다 — 다만 1편 본문에서는 이름을 따로
짚지 않았다. 실제 주석은 "에이전트 메시지 기록으로 남기되, 일반 스레드
제출 생애 주기를 그대로 쓰는 에이전트 간 통신"이라고 설명한다. 사람이
직접 새 서브 에이전트에게 작업을 준 것(`UserInput`)과, 다른 에이전트가
보낸 메시지로 시작된 것(`InterAgentCommunication`)을 타입 레벨에서부터
구분해 둔다. 주석은 "V2 통신 스폰은 통신과 컨텍스트를 묶어서, 중앙
집중식 제출/생애주기 로깅이 한쪽만 받는 일이 없게 한다"고 설명한다 —
메시지가 어디서 왔는지에 따라 로깅과 처리 방식이 달라진다는 뜻이다.

## 정리

| 질문 | 담당 코드 |
| --- | --- |
| 부모-자식 관계 추적 | `agent-graph-store`의 `AgentGraphStore` 트레이트 |
| 신원 증명 | `agent-identity`(Ed25519, JWT+JWKS) |
| 내장 역할 정의 | `core/src/agent/builtins/*.toml` |
| 권한 상속 원칙 | `role.rs`: "부모 세션의 권한을 넘어설 수 없다" |
| 닉네임 | `agent_names.txt`(철학자·과학자 101명) |
| 스폰 입력 구분 | `SpawnInitialInput::UserInput` vs `InterAgentCommunication` |

## 다음 편

`ModelClient`가 OpenAI API만 상대하는 줄 알았는데, 워크스페이스 목록에
`lmstudio`, `ollama`라는 crate도 있었다. 다음 편에서는 `model-provider/`를
열어서 Codex가 로컬 모델까지 어떻게 같은 인터페이스로 추상화하는지
본다.
