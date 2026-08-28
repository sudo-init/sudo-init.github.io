---
title: '해시가 같으면 LLM을 부르지 않는다 — 요약하는 메모리의 비용 구조'
slug: llm-wiki-incremental-cost
category: ai
description: '위키를 짓는 데는 LLM 호출이 든다. 원본이 늘어날수록, 그리고 바뀔수록 비용이 붙는다. 텐센트 코드에 있는 증분 분류 함수 하나가 이 방식의 비용 구조를 그대로 드러낸다.'
pubDate: 2026-08-29T11:00:00+09:00
tags: ['ai-agent', 'memory', 'llm-wiki', 'cost']
draft: true
---

[첫 글](/posts/llm-wiki-lineage/)에서 요약파의 대가로 두 가지를 적었다.
LLM 호출 비용과 요약 오류. 두 번째는 여러 번 다뤘으니 이 글은 첫 번째다.

벡터 임베딩은 한 번 찍으면 끝이다. 위키는 원본이 바뀔 때마다 LLM이 다시
읽고 다시 써야 한다. **이 차이가 실제 코드에서 어떻게 나타나는지** 봤다.

---

## 1. 증분 분류 함수 하나

텐센트 위키 엔진에 이런 순수 함수가 있다.

```ts
/**
 * 增量分类（설계 §3.6 step 3, 순수 함수라 단위 테스트가 쉽다）:
 * 디스크의 원본 파일과 source 테이블의 지난 상태를 비교해 각 파일의 행선지를 정한다.
 * - toIngest: 신규 || 추출 미완료(status≠ingested, uploaded/failed 포함) || sha 변경 → 추출 필요
 * - skipped : status=ingested 이고 sha 미변경 → LLM 건너뜀(토큰 절약)
 * - deleted : 테이블에는 있는데 디스크에 없음 → 연쇄 삭제 + source 행 삭제
 */
export function classifySources(
  disk: Array<{ filename: string; sha256: string }>,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
): { toIngest: string[]; skipped: string[]; deleted: string[] } {
  const diskNames = new Set(disk.map((d) => d.filename));
  const deleted = [...oldStates.keys()].filter((fn) => !diskNames.has(fn));
  const toIngest: string[] = [];
  const skipped: string[] = [];
  for (const d of disk) {
    const prev = oldStates.get(d.filename);
    if (!prev || prev.status !== "ingested" || prev.sha256 !== d.sha256) toIngest.push(d.filename);
    else skipped.push(d.filename);
  }
  return { toIngest, skipped, deleted };
}
```

스무 줄짜리 함수인데 **이 방식의 비용 구조가 여기 다 들어 있다.**

---

## 2. 세 갈래가 말하는 것

### `skipped` — 이 최적화가 존재한다는 사실 자체

```
status=ingested 且 sha 未变 → 跳过 LLM（省 token）
```

`省 token` — 토큰을 아낀다. **이런 최적화를 코드에 명시적으로 넣었다는 건
안 하면 아플 만큼 비싸다는 뜻이다.**

비교해보면 분명하다. 벡터 RAG에서 "이미 임베딩한 청크를 다시 임베딩하지
않기"는 최적화라기보다 당연한 캐싱이고, 안 해도 비용이 감당된다. 임베딩은
싸다. 반면 위키 생성은 원본 하나당 LLM이 전문을 읽고 여러 페이지를 쓰는
작업이다.

### `toIngest` — 세 가지 경우가 한 바구니에

```ts
if (!prev || prev.status !== "ingested" || prev.sha256 !== d.sha256)
```

- **신규** — 처음 보는 파일
- **미완료** — `status`가 `uploaded`나 `failed`인 것
- **변경** — SHA-256이 달라진 것

두 번째가 중요하다. 지난번에 LLM 호출이 실패했거나 중간에 끊긴 파일은
`ingested`가 아니므로 다시 시도한다. **실패가 영구화되지 않는다.**

세 번째가 이 방식의 비용을 결정한다. 원본 파일이 한 글자만 바뀌어도 SHA가
바뀌고, 그러면 그 파일 전체를 LLM이 다시 읽는다. **부분 갱신이 없다.**

문서 한 줄을 고쳤을 때:

```
벡터 RAG   → 바뀐 청크 1개만 재임베딩
LLM Wiki   → 원본 전체를 LLM 이 다시 읽고 페이지들을 다시 씀
```

### `deleted` — 지우는 것도 일이다

디스크에서 사라진 원본은 연쇄 삭제로 간다. 이건 [다른 글](/posts/llm-wiki-raw-and-derived/)에서
따로 다룬다. 여기서 짚을 건 **삭제도 상태 관리가 필요하다**는 점이다.
벡터 인덱스에서 지우는 건 ID로 지우면 끝이지만, 위키에서는 그 원본에서
파생된 페이지들을 찾아야 한다.

---

## 3. 순수 함수로 뽑아둔 것

주석에 `纯函数，便于单测` — 순수 함수라 단위 테스트가 쉽다고 적혀 있다.

디스크 상태와 이전 상태를 받아 세 목록을 돌려줄 뿐 파일도 안 읽고 DB도 안
건드린다. 그래서 "SHA가 같고 status가 ingested면 skipped로 가는가"를
테스트로 고정할 수 있다.

이게 왜 중요하냐면, **이 분류가 틀리면 비용이 조용히 새기 때문이다.**
`skipped`로 가야 할 파일이 매번 `toIngest`로 가면 아무도 모르는 채로 LLM
호출이 반복된다. 결과는 정상으로 보인다. 위키는 잘 만들어지고 청구서만
늘어난다.

이런 종류의 버그는 테스트로만 잡힌다.

---

## 4. 비용이 어디에 붙는가

지금까지 본 걸 모으면 LLM 호출 지점이 이렇다.

```
원본 1개 수집       → LLM 호출 (전문 읽고 페이지 생성)
배치 전체 종료      → LLM 호출 1회 (overview.md 종합)
index.md 갱신       → 없음
log.md 갱신         → 없음
```

[앞 글](/posts/llm-wiki-progressive-disclosure/)에서 본 계단이 여기서
비용 구조로 다시 나타난다. 목차와 타임라인은 공짜고, 종합은 배치당 한 번,
페이지 생성만 원본 수에 비례한다.

그래서 비용을 결정하는 건 **원본의 개수와 변경 빈도**다.

- 정적인 문서 더미(아키텍처 문서, 지난 RFC) → 한 번 수집하고 끝. 싸다.
- 자주 바뀌는 문서(진행 중인 스펙, 위키 페이지) → 바뀔 때마다 전체 재수집
- 대화 로그 → 계속 늘어남

세 번째가 문제다. 텐센트 제품에서 위키(`MemoryKnowledge`)와 대화
메모리(`MemoryCore`의 L0→L3)가 **별도 컴포넌트**인 게 이것과 무관하지
않아 보인다. 대화는 위키로 만들지 않고 계층 추출로 처리한다.

---

## 5. 그래서 무엇을 위키로 만들 것인가

이 비용 구조를 알고 나면 선택 기준이 생긴다.

**위키가 맞는 것** — 변경이 드물고, 구조가 있고, 여러 번 참조되는 것.
아키텍처 문서, 결정 기록, 코드베이스 컨벤션. 한 번 짓는 비용이 여러 번
읽히며 상각된다.

**위키가 안 맞는 것** — 계속 흘러가고, 한 번 읽히고 마는 것. 일상 대화,
로그, 알림. 이걸 위키로 만들면 짓는 비용이 회수되지 않는다.

`source_type`의 열거값이 이 구분을 이미 반영하고 있다.

```
source_type: requirement | architecture | meeting | rfc | decision | other
```

전부 **한 번 쓰이고 여러 번 참조되는 문서 종류**다. 채팅이나 로그가 목록에
없다.

---

## 6. 남는 문제

**스키마를 바꾸면 기존 페이지는 어떻게 되나.**

[앞 글](/posts/llm-wiki-schema-as-doc/)에서 `schema.md`를 고치면 메모리
구조가 바뀐다고 했다. 그런데 `classifySources`는 **스키마 변경을 감지하지
않는다.** SHA가 그대로면 `skipped`다. 그러면 옛 스키마로 만든 페이지와
새 스키마로 만든 페이지가 섞인다.

재수집을 강제하려면 원본을 건드려 SHA를 바꾸거나 `status`를 리셋해야 한다.
스키마 해시를 분류 조건에 넣으면 해결되는 문제로 보이는데, 그러면 스키마를
한 글자 고칠 때마다 전체 재수집이 돌아 비용이 폭발한다.

**쉬운 답이 없는 종류의 트레이드오프**이고, 코드는 지금 싼 쪽을 골라 뒀다.
그 선택이 어디에도 문서화돼 있지 않다는 게 이 글에서 찾은 유일한 아쉬움이다.
