---
title: '원본을 지우면 요약도 따라 지워져야 한다'
slug: llm-wiki-raw-and-derived
category: ai
description: 'LLM Wiki는 원본과 정제본을 둘 다 남긴다. 그러면 원본이 사라질 때 그 원본에서 나온 페이지는 어떻게 되나. 페이지 frontmatter 의 sources 필드 하나로 이 문제를 푸는 구현을 봤다.'
pubDate: 2026-08-29T17:00:00+09:00
tags: ['ai-agent', 'memory', 'llm-wiki', 'provenance']
draft: true
---

[첫 글](/posts/llm-wiki-lineage/) 마지막에 이렇게 적었다. 요약파 두 구현이
전부 원본을 따로 보관하고 있고, "정제는 하되 원본은 버리지 않는다"가 잠정
합의로 보인다고.

그런데 원본을 남긴다는 건 관리 대상이 둘이 된다는 뜻이다.

```
raw/sources/     원본 문서
wiki/            LLM 이 원본에서 만든 페이지
```

여기서 당연한 질문이 나온다. **원본을 지우면 그 원본에서 나온 페이지는
어떻게 되나.**

---

## 1. 남겨두면 유령이 된다

가만히 두면 위키에 근거 없는 페이지가 남는다. 누군가 잘못 올린 문서를
지웠는데, 그 문서를 읽고 만든 요약 페이지는 그대로 있는 상태다.

에이전트는 그 페이지를 읽고 답한다. 사람이 "그 문서 지웠는데?" 하고
물어도 에이전트는 근거를 댈 수 없다. 원본이 없으니까.

**요약파를 택하면 반드시 생기는 문제**다. 원본파(추가만 하는 이벤트 로그)에는
없다. 거기서는 이벤트를 지우지 않고, 지운다면 그 삭제 자체가 또 하나의
이벤트다.

---

## 2. 페이지가 자기 출처를 적어둔다

텐센트 쪽 해법은 단순하다. **모든 페이지의 frontmatter가 자기가 어느 원본에서
나왔는지를 배열로 갖는다.**

```
type(필수) / title / sources(우리 확장) / description / tags / timestamp
```

`sources(我方扩展)` — 우리 쪽 확장이라고 적혀 있다. OKF 표준 필드가 아니라
이 구현이 추가한 것이다.

```ts
sources?: string[];
```

그리고 필드 순서를 고정한다.

```
字段顺序固定（type→title→description→sources→tags→timestamp→其它）
```

순서를 고정하면 `git diff`가 안정적이다. 페이지 내용은 그대로인데 필드
순서만 바뀌어 전체가 변경된 것처럼 보이는 일이 없다.

---

## 3. 삭제가 연쇄한다

`cascade.ts`가 이 필드를 읽고 두 갈래로 처리한다.

```
cascade.ts — 삭제 연쇄(raw/rm 과 page/rm 의 하류 정리)

- deleteSourceFiles: raw 원본을 지우고, 각 page 의 frontmatter `sources` 에
    따라 연쇄한다 —
      그 원본을 독점하는 page → 삭제
      공유하는 page → 그 원본만 빼고 재작성
- cascadeDeleteWikiPagesWithRefs: wiki page 를 지우고, 다른 page 본문에서
    지워진 페이지를 가리키는 [[wikilink]](悬空链接)를 정리한다
```

구현이 그대로다.

```ts
const sources = Array.isArray(parsed.frontmatter.sources) ? ... : [];
if (sources.length === 0) continue;

const remaining = sources.filter((s) => !deletedNames.has(s));
if (remaining.length === sources.length) continue;   // 이 페이지는 무관

if (remaining.length === 0) {
  rmSync(pagePath, { force: true });                 // 독점 → 삭제
  deletedWikiPaths.push(pagePath);
} else {
  const rewritten = buildPage({ ...parsed.frontmatter, sources: remaining }, parsed.body);
  writeFileSync(pagePath, rewritten, "utf-8");       // 공유 → 재작성
  rewrittenSourcePages++;
}
```

세 갈래가 명확하다.

| 페이지의 상태 | 처리 |
|---|---|
| 지워진 원본을 참조하지 않음 | 건드리지 않음 |
| 지워진 원본**만** 참조 | **페이지 삭제** |
| 지워진 원본 + 다른 원본 참조 | **그 원본만 빼고 재작성** |

세 번째가 이 설계의 값어치다. 개념 페이지 하나가 RFC 세 개를 근거로 만들어졌다면,
그중 하나가 사라져도 페이지는 남되 **근거 목록에서 그 하나가 빠진다.**
페이지 본문은 그대로 두므로 내용이 낡을 수는 있지만, 최소한 **없는 문서를
근거로 내세우지는 않는다.**

그리고 반환값이 이렇다.

```ts
export interface DeleteSourceFilesResult {
  deletedWikiPaths: string[];      // 연쇄 삭제된 페이지
  rewrittenSourcePages: number;    // 재작성된 페이지 수
}
```

무엇이 얼마나 지워졌는지를 호출자에게 돌려준다. 조용히 안 지운다.

---

## 4. 끊어진 링크도 정리한다

페이지를 지우면 그 페이지를 가리키던 `[[wikilink]]`가 남는다. 주석의
`悬空链接` — 매달린 링크다.

`cascadeDeleteWikiPagesWithRefs`가 다른 페이지 본문을 훑어 지워진 페이지를
가리키는 링크를 정리한다.

이게 필요한 이유는 [목차 글](/posts/llm-wiki-progressive-disclosure/)에서
본 것과 이어진다. 위키는 링크 그래프이고, 에이전트가 링크를 따라 다닌다.
끊어진 링크를 남기면 에이전트가 없는 페이지를 읽으려다 실패하거나, 더
나쁘게는 링크 텍스트만 보고 내용을 추측한다.

구조 파일(`index.md`, `schema.md` 등)은 이 연쇄에서 제외된다
(`if (isStructural(relFromWiki)) continue`). 목차는 어차피 다음 수집 때
전체가 다시 생성되기 때문이다.

---

## 5. 이게 provenance 다

정리하면 이 설계는 **출처 추적(provenance)** 이다.

```
raw/sources/redis-rfc.md          원본
        ↓ (LLM 이 읽음)
wiki/concepts/caching-strategy.md
        frontmatter:
          sources: [redis-rfc.md, cache-meeting-0812.md]
```

페이지가 자기 근거를 명시적으로 들고 있으니 두 방향으로 쓸 수 있다.

**아래에서 위로** — 원본을 지우면 파생된 것을 찾아 정리한다. 이 글의 주제다.

**위에서 아래로** — 페이지를 읽다가 "이거 근거가 뭐지" 싶으면 `sources`를
보고 원본으로 간다. 에이전트도 사람도 쓸 수 있다.

두 번째가 [첫 글](/posts/llm-wiki-lineage/)에서 남긴 질문 — "위키가 틀렸는지
누가 확인하는가" — 에 대한 부분적인 답이기도 하다. 완전한 답은 아니다.
**대조할 수단은 있는데 정기적으로 대조가 도는 구조는 아니다.** 사람이
의심할 때 따라가는 경로다.

---

## 6. claude-obsidian 은 해시로 한다

같은 문제를 다른 방식으로 다룬다. [3-에이전트 글](/posts/llm-wiki-three-agents/)에서
본 대로, `wiki-ingest`가 돌려주는 게 이것이다.

> returns evidence-grounded page drafts, **expected hashes**, and proposed
> paths to the parent orchestrator.

`expected hashes` — 기대 해시다. 그리고 적용 단계에서 계획 전체의 SHA-256을
발급하고, 검토한 계획과 적용하는 계획이 다르면 `PLAN_CHANGED`로 막는다.

방향이 다르다. 텐센트의 `sources`는 **"이 페이지는 이 원본에서 나왔다"**는
관계를 남긴다. claude-obsidian의 해시는 **"이 페이지는 이 내용이어야
한다"**는 상태를 고정한다.

전자는 원본이 사라졌을 때 쓰이고, 후자는 적용 도중 무언가 바뀌었을 때
쓰인다. 둘 다 필요한 것으로 보이는데 한 구현이 둘 다 갖고 있지는 않았다.

---

## 7. 남는 것

원본과 정제본을 둘 다 두는 선택은 저장 공간과 복잡도를 대가로 **되짚을 수
있음**을 산다. 그 되짚기가 실제로 동작하려면 둘 사이의 연결이 데이터에
박혀 있어야 하고, `sources` 배열이 그 연결이다.

작은 필드 하나인데 없으면 이 방식 전체가 성립하지 않는다. 원본을 지울 때마다
위키 전체를 다시 만들거나, 유령 페이지를 방치하거나 둘 중 하나가 된다.

요약하는 메모리를 만든다면 **무엇에서 나왔는지를 산출물에 적어두는 것**이
가장 먼저 정해야 할 것 같다. 나중에 붙이기 어려운 종류의 결정이다.
