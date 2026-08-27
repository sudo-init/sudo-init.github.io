# analytics

블로그 방문자를 직접 세는 Cloudflare Worker. GitHub Pages 는 정적 호스팅이라
서버 로그가 없어서, 페이지가 보낸 비콘을 여기서 받아 D1 에 쌓는다.

호스팅형 집계 서비스(Cloudflare Web Analytics, GoatCounter 등)를 쓰지 않은
이유는 하나다. 그쪽 수집 주소가 광고 차단기 필터 목록에 올라 있어서, 이 블로그
독자층인 개발자가 통계에서 대거 빠진다. 커스텀 호스트명은 어느 목록에도 없다.

## 구성

```
블로그 (sudo-init.github.io)
  └─ src/components/Analytics.astro   비콘. BaseLayout 의 </body> 앞에서 실행된다.
        │  POST text/plain {"p": 경로, "r": 리퍼러}
        ▼
Worker (sudo-init-analytics.levdev.workers.dev)
  ├─ POST /hit    수집. Origin·봇 UA 를 거른 뒤 D1 에 한 줄 넣는다.
  └─ GET  /stats  대시보드. 토큰이 틀리면 404.
        │
        ▼
D1 (sudo-init-analytics, APAC/ICN)  단일 테이블 hits
```

## 개인정보

- **쿠키를 쓰지 않는다.** 동의 배너가 필요 없다.
- **IP 를 저장하지 않는다.** IP·User-Agent 는 `visitor` 해시의 재료로만 쓰이고 버려진다.
- **해시 salt 에 날짜가 섞여 있다.** 자정(KST)이 지나면 같은 사람도 다른 값이 되어,
  날짜를 넘겨 한 사람을 추적하는 일이 구조적으로 불가능하다.

그 대가로 **순 방문자는 하루 단위로만 셀 수 있다.** 대시보드의 "30일 방문"은
일별 방문자를 더한 값이지 30일 순 방문자가 아니다. 같은 사람이 이틀 오면 2로 세어진다.

## 내 방문 빼기

블로그 주소 뒤에 `?nostats=1` 을 붙여 한 번 열면 그 브라우저는 영구 제외된다.
localStorage 에 표시가 남기 때문에 브라우저·기기마다 한 번씩 해줘야 한다.
되돌리려면 `?nostats=0`.

로컬 개발 서버(`npm run dev`)는 비콘이 아예 나가지 않는다.

## 대시보드

주소는 `dashboard-url.txt` 에 있다. 토큰이 들어 있어 gitignore 되어 있다.

토큰을 새로 발급하려면:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))" > /tmp/t
npx wrangler secret put DASH_TOKEN < /tmp/t
# dashboard-url.txt 도 새 값으로 고쳐 쓰고, /tmp/t 는 지운다
```

`HASH_SALT` 를 바꾸면 그날 이후의 방문자 식별자가 전부 달라진다. 바꿀 이유가
없다면 그대로 둔다.

## 운영

```bash
npm run deploy      # Worker 배포
npm run typecheck   # 타입 검사
npx wrangler tail   # 실시간 로그

# 원본 데이터 직접 조회
npx wrangler d1 execute sudo-init-analytics --remote \
  --command "SELECT day, COUNT(*) pv, COUNT(DISTINCT visitor) uv FROM hits GROUP BY day ORDER BY day DESC LIMIT 14"

# 백업
npx wrangler d1 export sudo-init-analytics --remote --output backup.sql
```

스키마를 바꿀 일이 생기면 `schema.sql` 을 고치고 `npm run schema` 로 다시 적용한다.
(`CREATE TABLE IF NOT EXISTS` 라 기존 데이터는 건드리지 않는다. 컬럼 추가는
`ALTER TABLE` 로 따로 해야 한다.)

## 비용

**이 계정은 Workers Free 다. 청구가 구조적으로 불가능하다.**

Free 요금제는 하루 10만 요청(Workers), 하루 10만 행 쓰기(D1)까지다. 넘으면
**과금되는 게 아니라 요청이 실패한다.** 한도는 매일 00:00 UTC 에 초기화된다.

한도를 넘겼을 때 실제로 벌어지는 일:

- 비콘이 실패한다 → 그날 나머지 통계가 안 쌓인다. 독자 화면에는 아무 영향 없다
  (블로그는 GitHub Pages 정적 호스팅이라 이 Worker 와 무관하게 뜬다).
- `/stats` 도 같은 Worker 라 함께 막힌다. 다음 00:00 UTC 에 돌아온다.

페이지뷰 하나 = 요청 하나 = 행 하나다. 하루 1,000 페이지뷰라도 월 3만 요청이라
한도의 1% 도 안 쓴다. Paid 로 올릴 이유가 생기지 않는 한 그대로 두면 된다.

### 폭주 방어가 실제로 막아주는 것

`ratelimits` 바인딩 두 개를 걸어놨다. IP 당 30회/분, 수집 경로 전체 500회/분.
넘으면 D1 에 쓰지 않고 버린다.

무료 요금제에서 이게 지키는 건 **돈이 아니라 데이터다.** 누가 가짜 페이지뷰를
10만 개 밀어넣으면 통계가 쓰레기가 되는데, 그걸 막는다. D1 쓰기 한도도 함께
아낀다.

**Workers 요청 한도는 못 지킨다.** 거절도 Worker 가 깨어나서 하는 일이라
요청 수에는 이미 포함된 뒤다. 이건 한계이지 버그가 아니다.

그리고 이 바인딩은 상한선이 아니다. Cloudflare 문서가 "permissive, eventually
consistent, 정확한 집계 용도로 설계되지 않았다"고 명시한다. isolate 별 메모리
캐시로 판정하고 비동기로 전파하기 때문이다. 실측해보니 3초에 60회를 몰아치면
전부 통과했고, 13초에 300회를 보내자 그중 147회를 차단했다. 짧은 버스트는
새고, 지속되면 조인다.

전체 상한을 `/hit` 에만 건 이유가 여기 있다. 폭주하는 동안에도 `/stats` 는
열려 있어야 무슨 일이 벌어지는지 볼 수 있다.
