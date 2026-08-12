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

`src/content/blog/` 에 `.md` 파일을 추가한다. 파일 이름이 그대로 URL이 된다
(`hello.md` → `/posts/hello/`).

```yaml
---
title: '제목'
description: '목록과 검색 결과에 노출되는 한 줄 요약'
pubDate: 2026-08-12
updatedDate: 2026-08-20 # 선택
tags: ['astro'] # 선택
draft: false # true 면 개발 서버에서만 보인다
---
```

`_` 로 시작하는 파일은 아예 로드되지 않으므로 초안 보관용으로 쓸 수 있다.

## 배포

`main` 에 푸시하면 GitHub Actions가 빌드해 GitHub Pages로 배포한다
(`.github/workflows/deploy.yml`).

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
