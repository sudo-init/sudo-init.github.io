# Six C Archive

[sudo-init.github.io](https://sudo-init.github.io) — Astro로 만든 개인 개발 블로그.

## 개발

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # dist/ 생성
npm run preview  # 빌드 결과 확인
npm run check    # 타입 · 콘텐츠 스키마 검사
```

## 글 쓰기

`src/content/blog/` 에 `.md` 파일을 하나 만들면 끝이다. 파일 이름이 그대로
URL이 된다 (`hello.md` → `/posts/hello/`). 영문 소문자와 하이픈으로 짓는 것이
주소가 깔끔하다.

```yaml
---
title: '제목'
description: '목록과 공유 카드에 노출되는 한 줄 요약'
pubDate: 2026-08-13
updatedDate: 2026-08-20 # 선택
tags: ['astro', '비용'] # 선택
draft: true # 선택 — true 면 개발 서버에서만 보인다
---
```

`title`, `description`, `pubDate` 는 필수다. 빠지거나 형식이 틀리면 빌드가
실패하면서 어느 파일의 어느 항목인지 알려주므로, 오타를 배포 후에 발견할 일은
없다.

### 알아두면 좋은 것

- **같은 날 두 편**을 쓸 때는 시각까지 적는다 (`2026-08-13T18:00:00+09:00`).
  날짜만 같으면 순서가 정해지지 않는다. 목록은 항상 최신 글이 위다.
- **날짜는 한국 시간**으로 표시된다. 빌드는 UTC에서 돌지만 화면은 KST 기준이다.
- **목차는 자동**이다. 본문의 `##`, `###` 제목을 모아 오른쪽 여백에 띄운다
  (화면이 1376px 이상일 때). 제목이 두 개 이상이어야 나온다.
- **코드 블록**은 언어를 적으면 색이 입혀지고 다크 모드에서 알아서 바뀐다.
- **초안 보관**은 두 가지다. `draft: true` 는 목록에 안 뜨지만 개발 서버에서
  볼 수 있고, `_` 로 시작하는 파일(`_memo.md`)은 아예 읽지 않는다.

### 쓰는 순서

```bash
npm run dev                      # 띄워두면 저장할 때마다 바로 반영된다
# src/content/blog/새-글.md 작성
npm run build                    # 최종 확인 (초안은 빌드에서 빠진다)
git add . && git commit -m "..." && git push
```

## 배포

`main` 에 푸시하면 GitHub Actions가 빌드해 GitHub Pages로 배포한다
(`.github/workflows/deploy.yml`). 2~3분이면 반영되고, 진행 상황은 저장소
Actions 탭에서 볼 수 있다.

> 저장소 Settings → Pages → Source 가 **GitHub Actions** 로 설정되어 있어야 한다.

## 구조

```
src/
├── components/   헤더, 푸터, 글 목록, 태그 등 UI 조각
├── content/blog/ 글 (마크다운)
├── layouts/      BaseLayout(공통 셸), PostLayout(글 상세)
├── lib/posts.ts  글 조회 · 정렬 · 태그 · 읽는 시간
├── pages/        라우트
├── styles/       디자인 토큰과 본문 스타일
└── consts.ts     사이트 이름, 소개, 메뉴
```
