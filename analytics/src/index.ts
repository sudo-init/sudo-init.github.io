import { renderDashboard } from './dashboard';
import { kstDay, type Env } from './shared';


/**
 * 비콘이 자바스크립트로 나가기 때문에 크롤러 대부분은 애초에 여기 닿지 않는다.
 * 그래도 JS 를 실행하는 미리보기 봇이 있어 한 겹 더 거른다.
 */
const BOT =
  /bot\b|bot\/|crawler|crawl|spider|slurp|headless|phantom|puppeteer|playwright|selenium|curl\/|wget|python-requests|python-urllib|go-http-client|okhttp|axios|scrapy|lighthouse|pagespeed|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|twitter|linkedin|applebot|semrush|ahrefs|mj12|dotbot|petal|bytespider|gptbot|claudebot|ccbot|perplexity/i;

/**
 * 같은 사람인지 가리기 위한 값. IP 와 UA 를 재료로 쓰지만 원본은 저장하지 않는다.
 * salt 에 날짜가 섞여 있어 자정이 지나면 같은 사람도 다른 값이 된다 —
 * 그래서 날짜를 넘겨 사람을 추적하는 일이 구조적으로 불가능하다.
 */
async function visitorHash(secret: string, day: string, ip: string, ua: string) {
  const bytes = new TextEncoder().encode(`${secret}|${day}|${ip}|${ua}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest, 0, 10)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 질의 문자열과 프래그먼트를 떼고 길이를 제한한다. */
function cleanPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  const p = raw.split('?')[0].split('#')[0];
  return p.slice(0, 300);
}

/** 유입원은 호스트명만 남긴다. 사이트 안에서의 이동은 유입이 아니므로 버린다. */
function refHost(raw: unknown, selfOrigins: string[]): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const u = new URL(raw);
    if (selfOrigins.includes(u.origin)) return null;
    return u.hostname.slice(0, 120);
  } catch {
    return null;
  }
}

function corsHeaders(origin: string | null, allowed: string[]) {
  const ok = origin !== null && allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

/** 길이가 달라도 일찍 빠져나가지 않게 비교한다. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleHit(request: Request, env: Env, allowed: string[]): Promise<Response> {
  const headers = corsHeaders(request.headers.get('Origin'), allowed);
  // 실패해도 204 로 답한다. 무엇이 걸러졌는지 밖에서 알아낼 수 없게 한다.
  const done = () => new Response(null, { status: 204, headers });

  const origin = request.headers.get('Origin');
  if (origin === null || !allowed.includes(origin)) return done();

  const ua = request.headers.get('User-Agent') ?? '';
  if (ua === '' || BOT.test(ua)) return done();

  // 한 IP 가 1분에 30번 넘게 보내면 사람이 읽는 속도가 아니다. 버린다.
  // IP 는 이 판정에만 쓰이고 어디에도 저장되지 않는다.
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (!(await env.IP_LIMIT.limit({ key: ip })).success) return done();

  // 여러 IP 가 나눠서 들어오는 경우까지 막는 전체 상한. 수집 경로에만 건다 —
  // 폭주 중에도 /stats 는 열려 있어야 무슨 일이 벌어지는지 볼 수 있다.
  if (!(await env.ALL_LIMIT.limit({ key: 'hit' })).success) return done();

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 1024) return done();
    body = JSON.parse(text);
  } catch {
    return done();
  }
  if (typeof body !== 'object' || body === null) return done();

  const payload = body as Record<string, unknown>;
  const path = cleanPath(payload.p);
  if (path === null) return done();

  const now = Date.now();
  const day = kstDay(now);
  const visitor = await visitorHash(env.HASH_SALT, day, ip, ua);
  const country = (request as { cf?: { country?: string } }).cf?.country ?? null;

  try {
    await env.DB.prepare(
      'INSERT INTO hits (ts, day, path, ref, country, visitor) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(Math.floor(now / 1000), day, path, refHost(payload.r, allowed), country, visitor)
      .run();
  } catch {
    // 집계 실패가 방문자에게 보일 이유는 없다.
  }
  return done();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get('Origin'), allowed),
      });
    }

    if (url.pathname === '/hit' && request.method === 'POST') {
      return handleHit(request, env, allowed);
    }

    if (url.pathname === '/stats' && request.method === 'GET') {
      const token = url.searchParams.get('t') ?? '';
      // 토큰이 틀리면 404. 이 경로가 존재한다는 사실조차 알려주지 않는다.
      if (!safeEqual(token, env.DASH_TOKEN)) {
        return new Response('Not found', { status: 404 });
      }
      const days = Math.min(Math.max(Number(url.searchParams.get('d')) || 30, 1), 365);
      return renderDashboard(env, days, token);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
