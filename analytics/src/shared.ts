/** Workers 의 rate limit 바인딩. 넘치면 success 가 false 로 온다. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  /** IP 하나가 1분에 보낼 수 있는 비콘 수. */
  IP_LIMIT: RateLimiter;
  /** Worker 전체가 1분에 받아줄 요청 수. 청구서의 상한선 역할을 한다. */
  ALL_LIMIT: RateLimiter;
  /** 비콘을 받아줄 출처 목록. 쉼표로 구분한다. */
  ALLOWED_ORIGINS: string;
  /** 방문자 해시의 재료. wrangler secret 으로 넣는다. */
  HASH_SALT: string;
  /** /stats 를 여는 열쇠. wrangler secret 으로 넣는다. */
  DASH_TOKEN: string;
}

/** KST 기준 'YYYY-MM-DD'. 하루의 경계를 한국 시간에 맞춘다. */
export function kstDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}
