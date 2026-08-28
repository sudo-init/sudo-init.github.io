---
title: '기억의 구조를 마크다운 한 장으로 바꾼다'
slug: llm-wiki-schema-as-doc
category: ai
description: '벡터DB에서는 "이 프로젝트에서는 결정 페이지를 따로 만들어라"를 표현할 방법이 없다. LLM Wiki는 그걸 schema.md 한 장으로 한다. 그리고 사용자가 안 고친 기본 템플릿을 커스터마이즈로 세지 않는 판별 로직까지 있었다.'
pubDate: 2026-08-28T19:00:00+09:00
tags: ['ai-agent', 'memory', 'llm-wiki', 'prompt-engineering']
draft: true
---

[앞 글](/posts/llm-wiki-lineage/)에서 지나가듯 적은 게 하나 있다. 위키가
자기 스키마를 마크다운 문서로 선언하고 LLM이 그걸 읽어 페이지를 만든다는
것. 이 글은 그 한 문장을 파고든 것이다.

이게 왜 흥미롭냐면, **메모리 시스템에서 "구조를 바꾼다"가 보통은 코드
변경**이기 때문이다.

---

## 1. 벡터DB에서는 이걸 할 수 없다

RAG로 메모리를 만들면 조절할 수 있는 게 이 정도다.

```
임베딩 모델      어떤 벡터 공간을 쓸 것인가
청크 크기        몇 자씩 자를 것인가
top-k            몇 개를 꺼낼 것인가
메타데이터 필터   어떤 태그로 좁힐 것인가
```

전부 **검색 파라미터**다. "이 프로젝트에서는 회의록에서 *결정*만 따로
뽑아 페이지로 만들어라" 같은 건 표현할 자리가 없다. 그러려면 파이프라인
코드를 고쳐야 한다.

LLM Wiki는 다르다. LLM이 페이지를 짓는 방식이 **프롬프트에 들어가는
문서**로 정의돼 있으니, 그 문서를 바꾸면 구조가 바뀐다.

---

## 2. 기본 스키마

텐센트 쪽 `DEFAULT_SCHEMA`가 이렇다.

```markdown
# Page types
- entity  — 시스템의 구체적 구성요소나 역할. kind 필드 필수
- concept — 추상적 설계 개념 (아키텍처, 모듈 경계, 데이터 흐름,
            배포 모델, 권한 모델, 평가 프레임워크 등)
- source  — 수집된 원본 문서 하나당 요약 페이지. source_type 필드 필수
Other types (comparison, synthesis, etc.) may be created as needed.

# Fields / sections per type
- entity:
    - kind: module | service | platform | external_system | user_role | other (required)
    - definition: 책임 / 목적
    - key attributes: 주요 속성
    - relationships: 다른 개체와의 관계
- concept:
    - definition: 개념 정의
    - significance: 중요성 / 역할
    - related entities: 연관 개체
- source:
    - source_type: requirement | architecture | meeting | rfc | decision | other (required)
    - source document summary

# Naming & language
- slug: 소문자, 공백은 하이픈
- Output language: follow the source document — do not switch
```

몇 가지가 눈에 띈다.

**`Other types may be created as needed`** — 타입 목록이 닫혀 있지 않다.
LLM이 필요하면 새 타입을 만들어도 된다. 실제로 디렉터리에는
`comparisons`와 `synthesis`가 미리 만들어져 있다.

**`entity`의 `relationships`가 필수다.** 개체를 만들면 다른 개체와의 관계를
반드시 적어야 한다. 이게 위키를 그래프로 만드는 장치다. RAG에서 청크는
서로를 모른다.

**`source_type`의 열거값이 실무 어휘다.** `requirement | architecture |
meeting | rfc | decision | other`. 회의록과 RFC와 결정 기록을 구분한다.
이 목록만 봐도 이 도구가 어떤 팀을 상정하는지 보인다.

**`Output language: follow the source document — do not switch`** — 원본
언어를 따라가고 바꾸지 말라. 한국어 문서를 넣으면 한국어 페이지가 나와야
한다는 뜻이다. 이 한 줄이 없으면 LLM이 임의로 영어나 중국어로 번역해버린다.

---

## 3. 사용자가 바꿀 수 있다

`loadTemplate()`이 이렇게 생겼다.

```ts
/** 加载抽取模板。存在且有实质内容则用用户的；否则用领域中立默认。 */
export function loadTemplate(projectPath: string): WikiTemplate {
  const purpose = readTemplateFile(projectPath, "purpose.md");
  const schema  = readTemplateFile(projectPath, "schema.md");
  return {
    purpose: purpose ?? DEFAULT_PURPOSE,
    schema:  schema  ?? DEFAULT_SCHEMA,
    customized: purpose != null || schema != null,
  };
}
```

`wiki/schema.md`와 `wiki/purpose.md`를 읽어 있으면 쓰고 없으면 기본값을
쓴다. 주석의 `领域中立默认` — **도메인 중립 기본값**이라는 표현이 정확하다.
기본 스키마는 어떤 분야에도 안 맞게 일반적이고, 특정 분야에 맞추는 건
사용자 몫이다.

`purpose.md`는 "이 위키가 무엇을 위한 것인가"다. 스키마가 형식이라면 목적은
의도다. 둘 다 프롬프트에 들어간다.

그래서 이런 게 가능해진다.

```markdown
# wiki/schema.md 를 이렇게 고치면

# Page types
- decision — 팀이 내린 결정 하나당 한 페이지. 필수 필드:
    - status: proposed | accepted | superseded
    - context: 왜 이 결정이 필요했나
    - alternatives: 검토했으나 택하지 않은 안
    - consequences: 이 결정이 강제하는 것
- incident — 장애 하나당 한 페이지
    - severity / timeline / root_cause / action_items
```

코드를 한 줄도 안 고치고 메모리 구조가 바뀐다. 다음 수집부터 LLM이 회의록을
읽고 `decision` 페이지를 만든다.

---

## 4. "안 고친 템플릿"을 걸러내는 로직

여기서 세심한 게 나온다. `readTemplateFile`이 파일이 있다고 바로 쓰지
않는다.

```ts
/** 判断一段正文是否"有实质内容"（排除 init 写入的空壳占位）。 */
function hasMeaningfulContent(body: string): boolean {
  const stripped = body
    .replace(/^#.*$/gm, "")                 // 제목 줄 제거
    .replace(/Define\b[^.。]*[.。]?/gi, "")  // "Define ..." 자리표시자 제거
    .replace(/\s+/g, "");
  return stripped.length >= 8;
}
```

위키를 초기화하면 `schema.md`와 `purpose.md`가 **껍데기 상태로 생성된다.**
제목과 `Define ...` 같은 자리표시자 문장만 든 파일이다. 그걸 그대로 두면
파일은 존재하는데 내용이 없다.

이 함수가 그걸 판별한다. 제목 줄을 지우고, `Define`으로 시작하는 문장을
지우고, 공백을 지운 뒤 **8자 미만이면 실질 내용이 없다고 본다.** 그러면
`readTemplateFile`이 `null`을 돌려주고 기본값이 쓰인다.

작은 로직인데 이게 없으면 어떻게 되는지 생각해보면 의미가 분명하다. 껍데기
파일을 스키마로 쓰면 **LLM에게 빈 지침을 주는 셈**이 된다. 기본 스키마보다
나쁜 결과가 나온다. 파일 존재 여부만 보는 순진한 구현이 흔히 빠지는
함정이고, 여기는 안 빠졌다.

그리고 `customized` 플래그가 따로 나간다. 사용자가 실제로 손댔는지를
시스템이 안다는 뜻이다. 로그나 진단에 쓸 수 있다.

---

## 5. 이게 프롬프트 엔지니어링과 다른 점

"스키마를 문서로 준다"는 결국 프롬프트에 텍스트를 넣는 것이다. 그런데
보통의 프롬프트 튜닝과 성격이 다르다.

**하나, 산출물이 그 문서를 따른다는 걸 검증할 수 있다.** 스키마가
`entity`에 `relationships` 필수라고 했으면, 생성된 페이지의 frontmatter에
그게 있는지 확인하면 된다. 프롬프트를 "더 자세히 써줘"로 고치는 것과 달리
**합격 여부가 판정 가능하다.**

**둘, 문서가 산출물 옆에 있다.** `wiki/schema.md`는 위키 안에 있다. 페이지를
읽다가 "왜 이 필드가 있지" 싶으면 같은 디렉터리에서 답을 찾는다. 프롬프트가
코드 안에 문자열로 박혀 있으면 그게 안 된다.

**셋, 버전 관리가 된다.** 마크다운 파일이니 git에 들어간다. 스키마를 바꾼
시점과 그 후 생성된 페이지가 커밋 이력에 같이 남는다.

---

## 6. 한계

바꿀 수 있는 건 **LLM이 페이지를 쓰는 방식**뿐이다. 검색 방식, 계층 구조,
수집 파이프라인은 코드에 있다. 스키마에 "이 타입은 벡터 검색에서 가중치를
높여라"라고 적을 수는 없다.

그리고 스키마를 바꿔도 **기존 페이지는 그대로다.** 다음 수집부터 새 구조가
적용되므로, 위키 안에 옛 구조 페이지와 새 구조 페이지가 섞인다. 재수집을
강제하려면 원본의 SHA를 바꾸거나 상태를 리셋해야 하는데, 그 경로는
[다음 글](/posts/llm-wiki-incremental-cost/)에서 본다.

---

메모리 시스템에서 "구조를 바꾼다"가 코드 배포가 아니라 문서 편집이 되는
것 —— 그게 이 패턴에서 제일 실용적인 부분이라고 본다. 팀마다 기억해야 할
것의 모양이 다른데, 그걸 파이프라인 코드로 표현하면 팀마다 포크를 떠야
한다.
