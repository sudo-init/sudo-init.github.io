-- 방문 기록 한 줄이 페이지뷰 하나다.
-- IP 와 User-Agent 는 저장하지 않는다. 둘은 visitor 해시의 재료로만 쓰이고 버려진다.
CREATE TABLE IF NOT EXISTS hits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,  -- 유닉스 초
  day     TEXT    NOT NULL,  -- KST 기준 'YYYY-MM-DD'
  path    TEXT    NOT NULL,
  ref     TEXT,              -- 외부 유입원 호스트명. 내부 이동/직접 방문이면 NULL
  country TEXT,
  visitor TEXT    NOT NULL   -- 그날치 salt 로 만든 해시. 날이 바뀌면 값도 바뀐다.
);

CREATE INDEX IF NOT EXISTS hits_day         ON hits(day);
CREATE INDEX IF NOT EXISTS hits_day_path    ON hits(day, path);
CREATE INDEX IF NOT EXISTS hits_day_visitor ON hits(day, visitor);
