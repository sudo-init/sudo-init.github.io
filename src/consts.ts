export const SITE_TITLE = 'Six C Archive';
export const SITE_DESCRIPTION =
  '개발하며 부딪히고 배운 것들을 기록하는 공간. 삽질기, 정리 노트, 그리고 가끔의 잡담.';
export const AUTHOR = 'sixx';
export const LOCATION = 'Seoul, Korea';
export const GITHUB_URL = 'https://github.com/sudo-init';

/**
 * 사이트 이름의 유래가 된, 나를 설명하는 여섯 개의 C.
 * 문제 → 사람 → 삶을 대하는 태도 순으로 두 개씩 묶었다.
 */
export const SIX_C = [
  {
    word: 'curious',
    description:
      '잘 돌아가는데 왜 돌아가는지 모르면, 저는 아직 끝난 게 아니라고 생각합니다. 원인을 모른 채 넘어간 문제는 반드시 같은 얼굴로 다시 찾아오더라고요. 모르는 걸 모르는 채로 두는 게 제일 불편하기도 하고요. 좋은 질문 하나가 좋은 답 열 개보다 오래 간다고 믿습니다.',
  },
  {
    word: 'creative',
    description:
      '창의성은 없던 걸 지어내는 힘이 아니라, 이미 있는 것들을 남들이 잇지 않는 방식으로 잇는 힘이라고 생각합니다. 그래서 제약이 많을수록 오히려 재미있는 답이 나오더라고요. 넉넉할 때는 누구나 비슷한 결론에 닿습니다. 막힌 문제를 풀어준 아이디어는 대개 개발과 상관없는 데서 왔고, 그렇게 찾은 것이 세상에 없으면 그냥 만듭니다. 이 블로그도 그렇게 시작했습니다.',
  },
  {
    word: 'credible',
    description:
      '오래 가는 시스템과 오래 함께 일하고 싶은 사람은 같은 조건을 요구한다고 생각합니다. 예측할 수 있을 것, 그리고 상대를 존중할 것. 화려한 기능보다 새벽에 알림이 울리지 않는 쪽이 낫고, 말을 잘하는 사람보다 말한 대로 하는 사람이 낫다고 봅니다.',
  },
  {
    word: 'clear',
    description:
      '언제나 간단명료해야 한다고 생각합니다. 복잡하게 짜고 있다면 대개 제가 아직 문제를 덜 이해한 것이더라고요. 영리한 코드보다 심심해서 설명이 필요 없는 코드가 낫습니다.',
  },
  {
    word: 'commit',
    description:
      '커밋은 바뀐 것을 하나의 기록으로 남기는 일입니다. 저는 지나온 자리도 그렇게 남겨두려고 합니다. 무엇을 했는지는 시간이 지나도 남지만, 왜 그렇게 했는지는 그때 적어두지 않으면 사라지더라고요. 그래서 잘된 결과보다 거기까지 간 과정을, 성공보다 실패한 시도를 더 자세히 남깁니다. 그렇게 쌓인 기록이 결국 제가 걸어온 길이라고 생각합니다.',
  },
  {
    word: 'comic',
    description:
      '여유와 유머가 인생에서 중요하다고 생각합니다. 오래 남는 명작에는 늘 유머가 있더라고요. 심각해진다고 문제가 빨리 풀리는 것도 아니고요.',
  },
] as const;

export const NAV_LINKS = [
  { href: '/', label: 'Posts' },
  { href: '/tags/', label: 'Tags' },
  { href: '/about/', label: 'About' },
] as const;
