export const SITE_TITLE = 'Six C Archive';
export const SITE_DESCRIPTION =
  '개발하며 부딪히고 배운 것들을 기록하는 공간. 삽질기, 정리 노트, 그리고 가끔의 잡담.';
export const AUTHOR = 'sixx';
export const LOCATION = 'Seoul, Korea';
export const GITHUB_URL = 'https://github.com/sudo-init';

/** 사이트 이름의 유래가 된 여섯 개의 C. */
export const SIX_C = [
  'creative',
  'comic',
  'credible',
  'clear',
  'continuous',
  'commit',
] as const;

export const NAV_LINKS = [
  { href: '/', label: 'Posts' },
  { href: '/tags/', label: 'Tags' },
  { href: '/about/', label: 'About' },
] as const;
