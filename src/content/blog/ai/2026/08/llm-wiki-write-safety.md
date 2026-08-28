---
title: 'LLM에게 위키를 맡길 때, 파일 쓰기를 어떻게 줄 것인가'
slug: llm-wiki-write-safety
category: ai
description: '같은 LLM Wiki 패턴을 구현한 두 프로젝트가 가장 위험한 지점에서 정반대로 갈렸다. 한쪽은 LLM에게 파일 쓰기를 아예 주지 않고, 다른 쪽은 주되 커널 수준으로 가둔 뒤 안 되는 플랫폼에서는 멈춘다.'
pubDate: 2026-08-28T14:00:00+09:00
tags: ['ai-agent', 'memory', 'llm-wiki', 'security']
draft: true
---

[지난 글](/posts/llm-wiki-lineage/)에서 에이전트 메모리가 요약파와 원본파로
갈린다는 얘기를 했다. 요약파 — LLM에게 원본을 읽혀 위키를 쓰게 하는 방식 —
쪽에서 두 구현을 봤는데, 거기서 못 다룬 게 하나 있다.

**LLM이 위키를 "쓴다"고 할 때, 실제로 디스크에 파일을 만드는 주체가
누구인가.**

LLM에게 파일 쓰기 도구를 주면 편하다. 그런데 LLM이 `../../etc/passwd`에
쓰겠다고 하면 어떻게 할 것인가. 응답이 토큰 한도에 걸려 중간에 잘리면
디스크에는 무엇이 남는가.

두 구현이 정반대로 답했다. 그리고 그 답이 두 제품의 성격을 갈랐다.

---

## 1. 텐센트 — LLM에게 파일시스템을 주지 않는다

`TencentCloud/TencentDB-Agent-Memory`의 `file-protocol.ts` 헤더다.

```
LLM 不能自由写文件；它输出带边界标记的文本协议，由我们解析后落盘：

  <<<FILE path="wiki/sources/redis.md">>>
  ---
  type: source
  ---
  본문...
  <<<END>>>

一次响应可含多个 FILE 块。解析要容错：
  - 丢弃未闭合块（截断/超 token 时常见）。
  - 非法 path（非 wiki/ 内、含 ..、绝对路径）跳过并记录，不抛错。
```

LLM은 **경계 표시가 붙은 텍스트만 뱉는다.** 파싱과 저장은 호스트 코드가
한다. LLM에게는 애초에 쓰기 도구가 주어지지 않는다.

오류 처리가 구체적인 게 좋다.

**닫히지 않은 블록은 버린다.** 토큰 한도로 응답이 잘렸을 때 흔한 경우다.
`<<<FILE ...>>>`는 나왔는데 `<<<END>>>`가 안 나온 상태. 그대로 저장하면
절반만 쓰인 파일이 디스크에 남고, 다음번에 그게 정상 페이지인 줄 알고
읽힌다. 그래서 통째로 버린다.

**불법 경로는 건너뛰고 기록만 하되, 예외는 던지지 않는다.** `wiki/` 밖,
`..` 포함, 절대경로. 여기서 예외를 던지면 한 블록이 잘못됐다고 같은 응답의
정상 블록까지 날아간다. 한 응답에 여러 파일이 들어올 수 있으니 **부분
성공을 허용**하는 설계다.

---

## 2. claude-obsidian — 주되 커널 수준으로 가둔다

`AgriciDaniel/claude-obsidian`은 반대로 도구를 준다. 대신 경로를 잠근다.

```python
# claude_obsidian/transaction.py  (4,771줄)
def _open_parent_directory(...):
    """Open a target parent from the vault FD without following symlinks."""
    child = os.open(part, flags, dir_fd=descriptor)
    os.mkdir(part, 0o755, dir_fd=descriptor)
```

경로를 문자열로 조합해서 여는 게 아니라, **볼트 루트의 파일 디스크립터에서
시작해 한 칸씩 `dir_fd`로 내려간다.** POSIX의 `openat` 패턴이다.

왜 이렇게까지 하냐면, 경로를 문자열로 검증한 뒤 여는 방식에는 틈이 있기
때문이다. 검증과 열기 사이에 누군가 심볼릭 링크를 끼워 넣으면 검증을
통과한 경로가 다른 곳을 가리킨다. TOCTOU라고 부르는 종류의 문제다.
`dir_fd`로 내려가면 **검증한 그 디렉터리에서 여는 것이 보장된다.**

관련 함수 이름들이 목적을 그대로 말한다.

```python
def _safe_vault_path(vault_root, value):
    """Validate one canonical vault-relative path and reject symlink traversal."""
    # "transaction paths may not traverse symlinks or junctions"

def _safe_directory(...):
    """Return a non-symlink runtime directory confined to the vault."""
```

`junctions`까지 언급한다. 윈도우의 심볼릭 링크 유사물이다.

그리고 이게 안 되는 플랫폼에서는 **아예 거부한다.**

```
$ python -m claude_obsidian init ./vault --apply
ERR UNSUPPORTED_PLATFORM: vault writes require directory-descriptor
confinement (WSL/Linux or supported macOS); on native Windows run this
command inside WSL — read-only inspection and dry-runs work natively.

exit code = 2
$ ls ./vault
(아무것도 생성되지 않음)
```

윈도우에는 `dir_fd` 기반 `os.open`이 없다. 그래서 쓰기를 멈춘다. 디렉터리
하나도 만들지 않는다.

역할 분리도 강하다. `wiki-ingest` 에이전트의 헤더가 이렇다.

```
Read-only ingestion worker for one already-captured source. (...) returns
evidence-grounded page drafts, expected hashes, and proposed paths to the
parent orchestrator. **It never writes or applies the shared transaction.**

tools: Read, Grep, Glob, Bash
```

작업 에이전트는 **초안과 기대 해시와 제안 경로만 돌려준다.** 병합과 적용은
부모 오케스트레이터가 단 한 번, 하나의 트랜잭션 번들로 한다. 여러 워커가
동시에 돌아도 디스크를 건드리는 건 한 곳뿐이다.

쓰기 계획에는 SHA-256이 붙는다. 적용하려면 검토한 계획의 해시를 되넘겨야
하고, 그 사이 계획이 바뀌면 `PLAN_CHANGED`로 막힌다.

---

## 3. 두 선택을 나란히

| | 텐센트 | claude-obsidian |
|---|---|---|
| LLM의 쓰기 권한 | **없음** (텍스트 프로토콜만) | 있음, 단 `openat`으로 가둠 |
| 경로 검증 | 파싱 단계 문자열 검사 | 커널 FD 수준 |
| 잘린 응답 | 미닫힘 블록 폐기 | 트랜잭션 단위 적용 |
| 불법 경로 | 건너뛰고 로그, 부분 성공 허용 | 쓰기 전 실패 |
| 미지원 플랫폼 | 해당 없음 | **쓰기 거부** (exit 2) |
| 구현 복잡도 | 낮음 | 4,771줄 |

**텐센트 방식이 단순하다.** LLM에게 도구를 안 주니 도구 오용이 원천적으로
없다. 대신 방어선이 프로토콜 파서 하나다. 파서에 버그가 있으면 그게 곧
구멍이다.

**claude-obsidian 방식이 강하다.** TOCTOU까지 막고 플랫폼이 안 되면
멈춘다. 대신 트랜잭션 모듈 하나가 4,771줄이고, 윈도우에서는 쓰기가 안 된다.

---

## 4. 위협 모델이 다르다

어느 쪽이 맞다기보다 **지키려는 것이 다르다.**

**텐센트는 팀 서버에서 도는 제품이다.** 여러 사람의 문서를 계속 수집한다.
LLM 응답이 잘리거나 이상한 경로를 뱉는 건 규모가 커지면 반드시 일어난다.
그때마다 전체 수집이 실패하면 운영이 안 된다. 그래서 **부분 성공을
허용하는 관용적 파서**를 골랐다. 열 개 중 아홉 개가 들어가면 그걸로 됐다.

**claude-obsidian은 사용자 개인 볼트를 건드린다.** 몇 년치 노트가 든
디렉터리다. 한 번 잘못 쓰면 되돌리기 어렵고, 사용자는 그게 언제 망가졌는지
모른다. 그래서 **실패하면 아무것도 안 하는 쪽**을 골랐다. 아홉 개가
들어가도 하나가 위험하면 전부 멈춘다.

같은 패턴을 구현했는데 "무엇을 잃으면 안 되는가"가 달라서 정반대 설계가
나왔다.

---

## 5. 이게 왜 메모리 얘기인가

[지난 글](/posts/llm-wiki-lineage/)에서 요약파의 대가로 "LLM이 요약하면서
틀린다"를 적었다. 그건 **내용**의 문제였다. 이 글은 **매체**의 문제다.

LLM이 내용을 잘못 요약하면 위키에 틀린 문장이 남는다. 나쁘지만 고칠 수
있다. 열어서 읽고 수정하면 된다.

LLM이 파일을 잘못 쓰면 **위키 밖의 것이 망가진다.** 볼트 밖 경로에 쓰거나,
기존 파일을 반쯤 덮어쓰거나, 심볼릭 링크를 따라가 엉뚱한 데를 건드린다.
이건 고칠 수 있는 종류가 아니다.

요약파를 택하는 순간 **LLM에게 쓰기 권한을 어떤 형태로든 위임하게 된다.**
원본파(서명된 이벤트 로그)에는 없는 문제다. 거기서는 이벤트를 추가할 뿐
기존 것을 건드리지 않으니까.

그래서 이 질문은 구현 세부가 아니라 **요약파를 고른 대가의 일부**다.
그리고 두 구현 다 이걸 알고 각자의 답을 코드에 새겨뒀다.
