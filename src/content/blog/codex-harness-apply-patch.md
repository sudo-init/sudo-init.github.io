---
title: '코드로 읽는 Codex 하네스 (4) — 파일을 고치는 전용 언어'
description: 'apply-patch 크레이트를 열어, Codex가 왜 unified diff 대신 자체 패치 포맷을 만들었는지, 그 포맷을 스트리밍으로 파싱하고 퍼지 매칭으로 적용하는 방식을 코드로 확인했다.'
pubDate: 2026-08-21T16:30:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
draft: true
---

[3편](/posts/codex-harness-tool-system/)에서 도구 인벤토리를 훑을 때
`apply_patch`가 셸 명령이 아니라 독립된 도구라는 것만 확인하고 넘어갔다.
이번 편은 그 도구 하나를 통째로 판다. 커밋은 이 시리즈에서 계속 쓰는
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## 왜 unified diff가 아니라 자체 포맷인가

`apply-patch` 도구가 모델에게 요구하는 입력은 `git diff`가 뱉는 unified
diff가 아니다. 자체 포맷이 따로 있고, 심지어 이 포맷을 정의하는 **formal
Lark 문법 파일**(`core/src/tools/handlers/apply_patch.lark`)까지 저장소에
들어 있다.

```
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
```

실제 패치는 이렇게 생겼다(테스트 코드에서 그대로 가져온 예시).

```
*** Begin Patch
*** Update File: interleaved.txt
@@
 a
-b
+B
@@
 c
 d
-e
+E
@@
 f
+g
*** End of File
*** End Patch
```

unified diff와 닮았지만 다르다. `@@` 뒤에 헝크 위치(`-10,3 +10,4` 같은
줄 번호)가 없다. 대신 `@@` 하나가 "새 변경 묶음의 시작"만 표시하고, 그
뒤에 오는 컨텍스트 줄(` `)과 변경 줄(`-`/`+`)의 **내용**으로 파일 안에서
위치를 찾는다. 줄 번호를 아예 안 쓰는 이유는 뒤에서 볼 `seek_sequence`와
직결된다 — 모델이 파일을 새로 읽지 않고 기억에 의존해 패치를 쓸 때 줄
번호가 한두 줄 어긋나는 일이 흔한데, 내용 기반 탐색이면 그 어긋남을
어느 정도 흡수한다.

## 왜 파서가 두 개인가

`apply-patch/src/parser.rs`에 있는 일반 파서 말고,
`streaming_parser.rs`(924줄)에 **스트리밍 전용 파서**가 따로 있다.
`StreamingPatchParser`는 상태 머신이다.

```rust
enum StreamingParserMode {
    NotStarted,
    StartedPatch,
    AddFile,
    DeleteFile,
    UpdateFile { hunk_line_number: usize },
    EndedPatch,
}
```

모델이 함수 호출 인자를 만들 때 patch 텍스트를 토큰 단위로 스트리밍해서
뱉는다. 스트리밍 파서는 그 텍스트가 다 도착하기 전에, 들어오는 줄 단위로
바로바로 파싱한다. `ensure_update_hunk_is_not_empty` 같은 검증 함수는
헝크가 비어 있으면 `InvalidHunkError { message, line_number }`를 그
자리에서 반환한다 — 패치 전체가 끝나기를 기다렸다가 통짜로 검증하는 게
아니라, 잘못된 부분이 스트리밍되는 그 시점에 정확한 줄 번호와 함께
잡아낸다는 뜻이다. UI가 패치를 실시간으로 보여주면서 검증할 수 있는 것도
이 구조 덕분이다.

포맷에는 `*** Environment ID:`라는 마커도 있다. 1편에서 스치듯 언급한
원격 실행 구조와 이어진다 — 패치 하나가 어떤 실행 환경(로컬 또는 원격
샌드박스)에 적용돼야 하는지를 패치 자체에 실어 보낼 수 있다.

## 컨텍스트 줄이 살짝 달라도 패치는 적용된다

`seek_sequence.rs`가 실제로 패턴(컨텍스트+삭제 줄)을 파일 안에서 찾는
함수다. 함수 시작 주석이 전략을 요약한다.

> Matches are attempted with decreasing strictness: exact match, then
> ignoring trailing whitespace, then ignoring leading and trailing
> whitespace.

실제 구현은 네 단계로 점점 느슨해진다.

1. **완전 일치** — 줄 배열이 패턴과 정확히 같은 위치를 찾는다.
2. **`rstrip` 일치** — 각 줄의 끝 공백만 무시하고 비교한다.
3. **`trim` 일치** — 앞뒤 공백을 모두 무시하고 비교한다.
4. **유니코드 문장부호 정규화 일치** — EN DASH(`–`), NON-BREAKING
   HYPHEN(`‑`) 같은 특수 대시를 ASCII `-`로, 스마트 따옴표를 `'`/`"`로,
   논브레이킹 스페이스·전각 공백 등 여러 유니코드 공백 문자를 일반
   공백으로 바꾼 뒤 비교한다.

마지막 단계가 왜 있는지는 테스트 하나가 정확히 보여준다.
`test_update_line_with_unicode_dash`는 원본 파일에 EN DASH가 들어 있고
모델이 만든 패치는 평범한 ASCII 하이픈을 쓴 상황을 재현한다. 코드 주석은
이렇게 설명한다.

> Historically `git apply` succeeds in such scenarios but our internal
> matcher failed requiring an exact byte-for-byte match. The fuzzy-matching
> pass that normalises common punctuation should now bridge the gap.

`git apply`도 못 하던 걸 새로 만든 게 아니라, 자체 매처가 처음엔
`git apply`보다 깐깐해서 실패하던 걸 뒤늦게 따라잡은 흔적이다. 코드에는
이런 실전 디버깅 흔적이 더 있다. `pattern.len() > lines.len()`일 때
조기 반환하는 분기 옆에는 "이전에는 이 경우 out-of-bounds 슬라이스로
패닉이 났었다(2025-04-12 이전)"는 주석이 붙어 있다. 모델이 실제로 파일보다
긴 컨텍스트를 요구하는 패치를 만들어서 터뜨린 적이 있었다는 뜻이다.

## 실패해도 뭘 했는지는 정확히 기록한다

`apply-patch/src/lib.rs`의 `AppliedPatchDelta`는 단순히 "성공/실패"가
아니라 **실제로 반영된 변경**을 별도로 추적한다.

```rust
pub struct AppliedPatchDelta {
    changes: Vec<AppliedPatchChange>,
    exact: bool,
}
```

`exact` 플래그가 핵심인데, 의미가 미묘하다. "작업이 전부 성공했다"가
아니라 "`delta`에 기록된 내용이 실제로 일어난 일과 정확히 일치한다"는
뜻이다. 예를 들어 파일을 다른 위치로 옮기는 패치가 새 위치에 쓰기는
성공했는데 원래 위치 삭제가 권한 문제로 실패해도, `delta`에는 "새
위치에 이 내용이 추가됐다"는 사실만 정확히 남기 때문에 `exact`는
여전히 `true`다 — 작업은 실패했지만 뭐가 실제로 반영됐는지는 의심할
여지 없이 알기 때문이다. 테스트
(`test_failed_move_returns_committed_destination_delta`)가 이 시나리오를
그대로 검증한다. 반대로 심볼릭 링크를 지울 때는 `exact`가 `false`로
떨어진다 — 링크가 가리키던 내용을 삭제 시점에 신뢰할 수 있게 기록하기
어렵기 때문이다.

3편에서 본 `FunctionCallError::RespondToModel`과 같은 철학이다. 도구가
실패했을 때 "실패했다"는 사실만 던지는 게 아니라, **실패한 지점까지 실제로
무슨 일이 있었는지**를 구조화된 형태로 남겨서 위 레이어(승인 UI, 롤백
로직, 모델에게 보여줄 메시지)가 정확한 정보를 갖고 판단하게 한다.

## 정리

| 질문 | 실제 코드 |
| --- | --- |
| 패치 포맷은 무엇으로 정의돼 있나 | `apply_patch.lark`(formal grammar) |
| 스트리밍 중에 어떻게 파싱하나 | `streaming_parser.rs`의 `StreamingParserMode` 상태 머신 |
| 컨텍스트가 살짝 달라도 어떻게 찾나 | `seek_sequence.rs`의 4단계 완화 매칭 |
| 부분 실패는 어떻게 기록하나 | `AppliedPatchDelta`의 `exact` 플래그 |

## 다음 편

apply_patch가 파일을 쓸 수 있다는 건 결국 셸 명령도 실행할 수 있다는
뜻이고, 그 실행은 어딘가에서 격리돼야 한다. 다음 편에서는
`sandboxing/`, `linux-sandbox/`, `windows-sandbox-rs/`를 열어 Linux
(landlock+bwrap), macOS(seatbelt), Windows(ACL+WFP)가 각각 어떻게 같은
문제 — "이 프로세스가 뭘 만지게 둘 것인가" — 를 서로 다른 OS 프리미티브로
풀어내는지 본다.
