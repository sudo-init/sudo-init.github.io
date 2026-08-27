import { kstDay, type Env } from './shared';

const SITE = 'https://sudo-init.github.io';

type Row = Record<string, unknown>;

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function num(v: unknown): string {
  return Number(v ?? 0).toLocaleString('ko-KR');
}

/** ISO 3166 두 글자를 국기 이모지로. 값이 이상하면 빈 깃발로 둔다. */
function flag(code: unknown): string {
  const c = String(code ?? '');
  if (!/^[A-Z]{2}$/.test(c)) return '\u{1F3F4}';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** 오늘부터 거슬러 올라가며 날짜 키를 만든다. 한국은 서머타임이 없어 24시간 뺄셈이 정확하다. */
function dayKeys(days: number): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(kstDay(now - i * 86_400_000));
  return out;
}

export async function renderDashboard(env: Env, days: number, token: string): Promise<Response> {
  const keys = dayKeys(days);
  const from = keys[0];
  const today = keys[keys.length - 1];

  const [todayRes, seriesRes, pathRes, refRes, countryRes, totalRes] = await env.DB.batch<Row>([
    env.DB.prepare(
      'SELECT COUNT(*) AS pv, COUNT(DISTINCT visitor) AS uv FROM hits WHERE day = ?',
    ).bind(today),
    env.DB.prepare(
      'SELECT day, COUNT(*) AS pv, COUNT(DISTINCT visitor) AS uv FROM hits WHERE day >= ? GROUP BY day',
    ).bind(from),
    env.DB.prepare(
      'SELECT path, COUNT(*) AS pv, COUNT(DISTINCT visitor) AS uv FROM hits WHERE day >= ? GROUP BY path ORDER BY pv DESC LIMIT 20',
    ).bind(from),
    env.DB.prepare(
      'SELECT ref, COUNT(*) AS pv FROM hits WHERE day >= ? AND ref IS NOT NULL GROUP BY ref ORDER BY pv DESC LIMIT 12',
    ).bind(from),
    env.DB.prepare(
      'SELECT country, COUNT(*) AS pv FROM hits WHERE day >= ? AND country IS NOT NULL GROUP BY country ORDER BY pv DESC LIMIT 12',
    ).bind(from),
    env.DB.prepare('SELECT COUNT(*) AS pv, MIN(day) AS first FROM hits'),
  ]);

  const byDay = new Map<string, { pv: number; uv: number }>();
  for (const r of seriesRes.results) {
    byDay.set(String(r.day), { pv: Number(r.pv), uv: Number(r.uv) });
  }
  const series = keys.map((d) => ({ day: d, ...(byDay.get(d) ?? { pv: 0, uv: 0 }) }));
  const maxUv = Math.max(1, ...series.map((s) => s.uv));
  const sumPv = series.reduce((a, s) => a + s.pv, 0);
  const sumUv = series.reduce((a, s) => a + s.uv, 0);

  const t = todayRes.results[0] ?? { pv: 0, uv: 0 };
  const total = totalRes.results[0] ?? { pv: 0, first: null };

  const tab = (d: number, label: string) =>
    `<a class="tab${d === days ? ' on' : ''}" href="?t=${encodeURIComponent(token)}&amp;d=${d}">${label}</a>`;

  // 막대 하나가 하루. 값이 0 인 날도 자리를 비워두어 공백이 그대로 드러나게 한다.
  const bars = series
    .map((s) => {
      const h = ((s.uv / maxUv) * 100).toFixed(2);
      return `<div class="slot" data-d="${s.day}" data-uv="${s.uv}" data-pv="${s.pv}" tabindex="0"><div class="bar" style="height:${h}%"></div></div>`;
    })
    .join('');

  const rows = (list: Row[], cells: (r: Row) => string, empty: string, span: number) =>
    list.length === 0
      ? `<tr><td class="empty" colspan="${span}">${empty}</td></tr>`
      : list.map((r) => `<tr>${cells(r)}</tr>`).join('');

  const dayTable = series
    .slice()
    .reverse()
    .map(
      (s) =>
        `<tr><td>${esc(s.day)}</td><td class="n">${num(s.uv)}</td><td class="n">${num(s.pv)}</td></tr>`,
    )
    .join('');

  const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>방문 통계 · sudo-init</title>
<style>
:root {
  color-scheme: light;
  --surface-1: #fcfcfb;
  --surface-2: #ffffff;
  --border: #e5e4e0;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #83817b;
  --series-1: #2a78d6;
  --grid: #ececE8;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --surface-2: #212120;
    --border: #33332f;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #8c8b82;
    --series-1: #3987e5;
    --grid: #2b2b28;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 20px 64px;
  background: var(--surface-1); color: var(--text-primary);
  font: 15px/1.6 ui-sans-serif, system-ui, Pretendard, "Apple SD Gothic Neo", sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 960px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
.sub { color: var(--text-muted); font-size: 13px; margin: 0 0 24px; }
.tabs { display: flex; gap: 4px; margin: 0 0 24px; }
.tab {
  padding: 5px 12px; border-radius: 999px; font-size: 13px; text-decoration: none;
  color: var(--text-secondary); border: 1px solid var(--border);
}
.tab.on { background: var(--series-1); border-color: var(--series-1); color: #fff; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 28px; }
.tile { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.tile .k { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
.tile .v { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.card { background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px; padding: 18px 18px 14px; margin-bottom: 20px; }
.card h2 { font-size: 14px; margin: 0 0 2px; }
.card .note { font-size: 12px; color: var(--text-muted); margin: 0 0 18px; }
.chart { position: relative; padding-top: 14px; }
.ymax { position: absolute; top: 0; left: 0; font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.plot { display: flex; align-items: flex-end; gap: 2px; height: 160px; border-top: 1px dashed var(--grid); border-bottom: 1px solid var(--border); }
.slot { flex: 1 1 0; height: 100%; display: flex; align-items: flex-end; min-width: 0; }
.slot:hover .bar, .slot:focus-visible .bar { filter: brightness(1.15); }
.slot:focus-visible { outline: 2px solid var(--series-1); outline-offset: 2px; }
.bar { width: 100%; background: var(--series-1); border-radius: 4px 4px 0 0; }
.xaxis { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted); margin-top: 6px; font-variant-numeric: tabular-nums; }
.tip {
  position: fixed; pointer-events: none; opacity: 0; transition: opacity .1s;
  background: var(--text-primary); color: var(--surface-1);
  padding: 6px 10px; border-radius: 6px; font-size: 12px; white-space: nowrap; z-index: 10;
  font-variant-numeric: tabular-nums; top: 0; left: 0;
}
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 500; color: var(--text-muted); font-size: 11px; padding: 0 0 6px; border-bottom: 1px solid var(--border); }
th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; padding-left: 12px; }
td { padding: 7px 0; border-bottom: 1px solid var(--border); color: var(--text-secondary); }
tr:last-child td { border-bottom: 0; }
td a { color: var(--text-primary); text-decoration: none; }
td a:hover { text-decoration: underline; }
.trunc { display: block; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--text-muted); padding: 18px 0; text-align: center; }
details { margin-top: 14px; }
summary { font-size: 12px; color: var(--text-muted); cursor: pointer; }
details table { margin-top: 10px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>방문 통계</h1>
  <p class="sub">sudo-init.github.io · KST 기준 · 첫 기록 ${esc(total.first ?? '아직 없음')}</p>

  <nav class="tabs">${tab(7, '7일')}${tab(30, '30일')}${tab(90, '90일')}</nav>

  <section class="tiles">
    <div class="tile"><div class="k">오늘 방문자</div><div class="v">${num(t.uv)}</div></div>
    <div class="tile"><div class="k">오늘 페이지뷰</div><div class="v">${num(t.pv)}</div></div>
    <div class="tile"><div class="k">${days}일 방문</div><div class="v">${num(sumUv)}</div></div>
    <div class="tile"><div class="k">${days}일 페이지뷰</div><div class="v">${num(sumPv)}</div></div>
    <div class="tile"><div class="k">전체 페이지뷰</div><div class="v">${num(total.pv)}</div></div>
  </section>

  <section class="card">
    <h2>일별 방문자</h2>
    <p class="note">중복 제거는 하루 단위로만 이뤄진다. 식별자가 매일 새로 만들어지므로 같은 사람이 이틀 오면 2로 세어진다.</p>
    <div class="chart">
      <div class="ymax">${num(maxUv)}</div>
      <div class="plot" id="plot">${bars}</div>
      <div class="xaxis"><span>${esc(from)}</span><span>${esc(today)}</span></div>
    </div>
    <details>
      <summary>표로 보기</summary>
      <div class="scroll">
        <table>
          <thead><tr><th>날짜</th><th class="n">방문자</th><th class="n">페이지뷰</th></tr></thead>
          <tbody>${dayTable}</tbody>
        </table>
      </div>
    </details>
  </section>

  <section class="card">
    <h2>많이 읽힌 글</h2>
    <p class="note">최근 ${days}일</p>
    <div class="scroll">
      <table>
        <thead><tr><th>경로</th><th class="n">방문</th><th class="n">페이지뷰</th></tr></thead>
        <tbody>${rows(
          pathRes.results,
          (r) =>
            `<td><a href="${SITE}${esc(r.path)}" target="_blank" rel="noreferrer"><span class="trunc">${esc(r.path)}</span></a></td><td class="n">${num(r.uv)}</td><td class="n">${num(r.pv)}</td>`,
          '아직 기록이 없다',
          3,
        )}</tbody>
      </table>
    </div>
  </section>

  <div class="cols">
    <section class="card">
      <h2>유입 경로</h2>
      <p class="note">최근 ${days}일 · 외부에서 들어온 것만</p>
      <div class="scroll">
        <table>
          <thead><tr><th>출처</th><th class="n">페이지뷰</th></tr></thead>
          <tbody>${rows(
            refRes.results,
            (r) => `<td><span class="trunc">${esc(r.ref)}</span></td><td class="n">${num(r.pv)}</td>`,
            '직접 방문뿐이다',
            2,
          )}</tbody>
        </table>
      </div>
    </section>
    <section class="card">
      <h2>국가</h2>
      <p class="note">최근 ${days}일</p>
      <div class="scroll">
        <table>
          <thead><tr><th>국가</th><th class="n">페이지뷰</th></tr></thead>
          <tbody>${rows(
            countryRes.results,
            (r) => `<td>${flag(r.country)} ${esc(r.country)}</td><td class="n">${num(r.pv)}</td>`,
            '아직 기록이 없다',
            2,
          )}</tbody>
        </table>
      </div>
    </section>
  </div>
</div>

<div class="tip" id="tip"></div>
<script>
(() => {
  const tip = document.getElementById('tip');
  const plot = document.getElementById('plot');
  const show = (el) => {
    tip.textContent = el.dataset.d + ' · 방문자 ' + el.dataset.uv + ' · 페이지뷰 ' + el.dataset.pv;
    tip.style.opacity = '1';
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, 8), window.innerWidth - w - 8);
    tip.style.transform = 'translate(' + x + 'px,' + (r.top - tip.offsetHeight - 8) + 'px)';
  };
  const hide = () => { tip.style.opacity = '0'; };
  plot.addEventListener('mouseover', (e) => { const s = e.target.closest('.slot'); if (s) show(s); });
  plot.addEventListener('mouseleave', hide);
  plot.addEventListener('focusin', (e) => { const s = e.target.closest('.slot'); if (s) show(s); });
  plot.addEventListener('focusout', hide);
})();
</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
