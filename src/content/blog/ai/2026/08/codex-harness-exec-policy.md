---
title: '코드로 읽는 Codex 하네스 (7) — 이 명령, 물어보지 않고 실행해도 될까'
slug: codex-harness-exec-policy
category: ai
description: 'execpolicy와 shell-command 크레이트를 열어, Codex가 어떤 셸 명령을 사람에게 묻지 않고 자동 승인하는지 결정하는 규칙과, 그 판정 로직 자체가 지켜야 하는 안전 원칙을 코드로 확인했다.'
pubDate: 2026-08-22T10:00:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
draft: true
---

[3편](/posts/codex-harness-tool-system/)에서 승인 경로가 두 갈래(사람 승인,
Guardian)라는 것까지 봤다. 그런데 애초에 "사람에게 물어볼지 말지"를 결정하는
판정 로직 자체는 열어보지 않았다. 이번 편이 그 부분이다. 커밋은 이
시리즈에서 계속 쓰는
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## 판정 결과는 셋뿐이다

[`execpolicy/src/decision.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/execpolicy/src/decision.rs)는
27줄짜리 파일인데, 이 시리즈 전체에서 나온 승인 관련 코드가 결국 이
세 값 중 하나로 수렴한다.

```rust
pub enum Decision {
    /// Command may run without further approval.
    Allow,
    /// Request explicit user approval; rejected outright when running with `approval_policy="never"`.
    Prompt,
    /// Command is blocked without further consideration.
    Forbidden,
}
```

`Prompt`의 주석이 흥미롭다 — 사람에게 물어보는 것조차 하나의 정책 선택지다.
`protocol.rs`의 `AskForApproval::Never` 주석은 이렇게 못 박는다.

> Never ask the user to approve commands. Failures are immediately returned
> to the model, and never escalated to the user for approval.

즉 `Never` 모드에서는 `Prompt` 판정이 나와도 사람에게 묻지 않고 그냥 실패
처리한다. "물어볼지 말지"조차 하네스가 정책으로 강제하는 대상이다.

## 안전 목록은 생각보다 훨씬 좁다

자동 승인(`Allow`)의 핵심은
[`shell-command/src/command_safety/is_safe_command.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/shell-command/src/command_safety/is_safe_command.rs)의
`is_known_safe_command`다. 무조건 안전한 명령 목록부터 보면 이렇다.

```rust
Some(
    "cat" | "cd" | "cut" | "echo" | "expr" | "false" | "grep" | "head" |
    "id" | "ls" | "nl" | "paste" | "pwd" | "rev" | "seq" | "stat" |
    "tail" | "tr" | "true" | "uname" | "uniq" | "wc" | "which" | "whoami"
) => true,
```

`cargo`, `npm`, `python` 같은 건 이 목록에 아예 없다. 대신 순수하게 읽기만
하는 POSIX 유틸리티로 좁게 잡혀 있다. 그리고 몇몇 명령은 조건부다.

- **`base64`** — `-o`/`--output`(파일에 쓰기)가 없을 때만 안전. 인코딩
  도구로 우회해서 파일을 쓰는 걸 막는다.
- **`find`** — `-exec`/`-execdir`/`-ok`/`-okdir`(임의 명령 실행),
  `-delete`, `-fls`/`-fprint*`(파일에 쓰기)가 없을 때만 안전.
- **`rg`(ripgrep)** — `--pre`/`--hostname-bin`(외부 명령 실행),
  `--search-zip`/`-z`(압축 도구 호출)가 없을 때만 안전.
- **`sed`** — `-n {N|M,N}p` 패턴(특정 줄만 출력)일 때만 안전. 정규식으로
  검증한다(`is_valid_sed_n_arg`).

그리고 하나는 예외 없이 항상 `false`다.

```rust
// Repository configuration can make even read-only Git commands execute helpers.
Some("git") => false,
```

`git status`, `git log`, `git diff`처럼 겉보기엔 완전히 읽기 전용인
명령도 전부 안전 목록에서 빠진다. 이유는 주석 그대로다 — 저장소 설정
(`.git/config`, `core.fsmonitor`, 페이저/디프 도구 설정 등)이 얼마든지
헬퍼 프로그램을 실행시킬 수 있어서, 인자만 보고는 안전한지 판단할 수
없다. 테스트 이름이 이 판단을 그대로 문서화한다 —
`git_commands_are_not_known_safe`, 검증 메시지는 "Git must not be trusted
from its arguments alone."

## `bash -lc "..."` 스크립트도 안전 판정이 된다

명령 하나가 아니라 셸 스크립트 전체가 들어와도 판정한다. 스크립트를
`&&`, `||`, `;`, `|`로만 이어붙인 "평범한" 명령들로 쪼갤 수 있고, 쪼갠
명령 전부가 개별적으로 안전하면 전체를 안전으로 본다.

```rust
if let Some(all_commands) = parse_shell_lc_plain_commands(&command)
    && !all_commands.is_empty()
    && all_commands.iter().all(|cmd| is_safe_to_call_with_exec(cmd))
{
    return true;
}
```

`ls && pwd`, `grep -R "Cargo.toml" -n || true`, `ls | wc -l`은 전부
안전으로 통과한다. 반면 서브셸과 리다이렉션은 파서가 무슨 일이 일어날지
증명할 수 없다는 이유로 전부 거부된다. 테스트 주석이 이유를 정확히
설명한다.

- `(ls)` → "Parentheses (subshell) are not provably safe with the current parser"
- `ls > out.txt` → "> redirection should be rejected"

"안전해 보이지만 증명은 못 한다"와 "위험하다고 증명됐다"를 구분해서,
증명 못 하는 쪽은 전부 보수적으로 거부하는 태도다.

## 위험 목록은 따로 있고, 래퍼를 뚫고 본다

안전 목록과 별개로
[`is_dangerous_command.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/shell-command/src/command_safety/is_dangerous_command.rs)라는
위험 목록도 있다. 대표 사례가 강제 삭제다.

```rust
Some("rm") if rm_args_include_force_option(&command[1..]) => {
    Some(DangerousCommandMatch::ForcedRm)
}
```

`rm_args_include_force_option`은 `--force`뿐 아니라 `-rf`처럼 묶인
짧은 플래그 안에 `f`가 섞여 있는 것도 잡아내고, `--` 이후 인자는 파일명으로
보고 스캔을 멈춘다. 더 흥미로운 건 래퍼 명령을 재귀적으로 뚫어본다는
점이다.

```rust
Some("sudo") => dangerous_command_match_with_depth(&command[1..], wrapper_depth + 1),
Some("env") => dangerous_command_match_for_env(command, wrapper_depth),
Some("trap") => dangerous_command_match_for_trap(command, wrapper_depth),
```

`sudo rm -rf /`, `env FOO=bar rm -rf /`처럼 진짜 위험한 명령을 다른
명령으로 감싸도 그 안까지 들어가서 확인한다. 무한 래핑으로 검사를
우회하는 걸 막으려고 재귀 깊이를 8로 제한해 둔 것도 눈에 띈다
(`MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH`).

## 판정 코드 자신은 아무것도 실행하면 안 된다

이 판정 로직에서 가장 인상 깊었던 부분이다. Windows에서는 PowerShell
명령의 안전성까지 판단해야 하는데, 이때 실제 PowerShell 바이너리를 찾아
실행해 보는 방식이면 안 된다 — "안전한지 검사하는 행위" 자체가 부작용을
일으키면 그 자체가 보안 구멍이기 때문이다. 이걸 증명하는 테스트가
`is_safe_command.rs` 안에 있다.

```rust
#[cfg(unix)]
#[test]
fn non_windows_safe_classification_does_not_spawn_repo_powershell_path() {
```

이 테스트는 마커 파일을 쓰기만 하는 가짜 `pwsh` 실행 파일을 임시
디렉터리에 만들어 두고, 그 경로를 명령으로 안전성 분류기에 넘긴다.
분류기가 끝난 뒤 마커 파일이 존재하지 않는지 확인한다 — 판정 로직이
실제로 그 파일을 실행하지 않았다는 걸 증명하는 것이다. "명령이 안전한지
확인하는 코드가 그 명령을 실행해 버리면 안 된다"는, 정적 분석기가
지켜야 할 원칙을 코드로 강제해 둔 사례다.

## 승인 자체도 다섯 갈래로 쪼개진다

`Prompt` 판정이 나왔다고 다 같은 방식으로 사람에게 물어보는 것도 아니다.
`AskForApproval::Granular` 아래에는 `GranularApprovalConfig`가 있고,
독립된 다섯 개의 스위치로 나뉜다.

| 필드 | 무엇을 허용할지 |
| --- | --- |
| `sandbox_approval` | 셸 명령 실행 승인 요청 |
| `rules` | execpolicy `prompt` 규칙이 일으키는 프롬프트 |
| `skill_approval` | 스킬 스크립트 실행 승인 |
| `request_permissions` | `request_permissions` 도구가 일으키는 프롬프트 |
| `mcp_elicitations` | MCP elicitation 프롬프트 |

셸 명령 승인은 막아 두면서 MCP elicitation만 허용하는 식의 조합이
가능하다는 뜻이다. "사람에게 물어봐도 되는가"라는 질문 하나가 아니라,
어떤 종류의 질문이냐에 따라 다섯 개로 쪼개져 있다.

## 이 전부를 묶는 자리

`core/src/exec_policy.rs`(1,166줄)가 지금까지 본 조각들 — 안전 목록,
위험 목록, `execpolicy` crate의 규칙 엔진 — 을 하나로 묶는다. 특히
`execpolicy` crate는 하드코딩된 목록과 별개로, 사용자가 직접
`.rules` 확장자 파일로 규칙을 추가할 수 있는 정책 엔진이다
(`DEFAULT_POLICY_FILE = "default.rules"`). 런타임에 "이 명령은 항상
허용해"라고 정한 걸 `blocking_append_allow_prefix_rule`로 바로 규칙에
추가할 수도 있다. 반대로 `BANNED_PREFIX_SUGGESTIONS`에는 `/bin/bash`,
`/bin/bash -c` 같은 프리픽스가 금지 목록으로 박혀 있다 — 셸을 직접
재호출해서 이 모든 분석 자체를 우회하는 경로를 막아 둔 것으로 보인다.

## 정리

| 질문 | 담당 코드 |
| --- | --- |
| 판정 결과의 종류 | `execpolicy::Decision`(`Allow`/`Prompt`/`Forbidden`) |
| 무조건 안전한 명령 | `is_known_safe_command`의 화이트리스트 |
| 조건부 안전 명령 | `base64`/`find`/`rg`/`sed`의 플래그별 분기 |
| 절대 안전하지 않은 명령 | `git`(저장소 설정이 헬퍼를 실행할 수 있어서) |
| 스크립트 전체 판정 | `bash -lc` + `&&`/`\|\|`/`;`/`\|`만 허용, 서브셸·리다이렉션 거부 |
| 위험 명령과 래퍼 우회 | `is_dangerous_command`, `sudo`/`env`/`trap` 재귀 언래핑 |
| 승인 프롬프트 세분화 | `GranularApprovalConfig`의 5개 독립 스위치 |
| 사용자 정의 규칙 | `execpolicy`의 `.rules` 파일, `core/src/exec_policy.rs` |

## 다음 편

`tools/lib.rs`를 다시 보면 `code_mode`라는 모듈이 있었다. 다음 편에서는
`code-mode*` crate 네 개와, 저장소에 왜 `v8-poc`라는 crate까지 있는지를
연다 — 모델이 매 턴 함수 하나씩 부르는 대신 스크립트를 짜서 여러 도구를
한 번에 호출하는 구조로 보이는데, 그걸 실제로 어떻게 격리해서 실행하는지
확인한다.
