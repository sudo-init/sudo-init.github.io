---
title: '코드로 읽는 Codex 하네스 (5) — 정책은 하나, 감옥은 셋'
description: 'sandboxing 크레이트를 열어, Codex가 정의한 OS 중립적 샌드박스 정책 하나를 macOS Seatbelt·Linux bubblewrap+landlock·Windows 제한 토큰이 각각 어떻게 구현하는지 코드로 확인했다.'
pubDate: 2026-08-21T19:00:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
draft: true
---

[4편](/posts/codex-harness-apply-patch/)에서 apply_patch가 파일을 쓸 수
있다는 걸 봤다. 파일을 쓸 수 있으면 셸 명령도 실행할 수 있고, 그 실행은
어딘가에서 막혀야 한다. 이번 편은 그 "막는 자리"를 연다. 커밋은 이
시리즈에서 계속 쓰는
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## 정책은 OS 중립적으로 하나만 정의한다

먼저 짚을 게 있다. "뭘 허용할지"를 정하는 정책과 "그걸 어떻게 강제할지"를
정하는 구현은 코드에서 완전히 분리돼 있다. 정책은
[`protocol/src/protocol.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/protocol/src/protocol.rs#L1003)의
`SandboxPolicy` 하나로 정의된다.

```rust
pub enum SandboxPolicy {
    DangerFullAccess,
    ReadOnly { network_access: bool },
    ExternalSandbox { network_access: NetworkAccess },
    WorkspaceWrite {
        writable_roots: Vec<AbsolutePathBuf>,
        network_access: bool,
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    },
}
```

이 enum 어디에도 seccomp니 landlock이니 ACL이니 하는 OS별 개념이 없다.
"쓰기가 되는 루트가 어디까지인지", "네트워크가 되는지"만 정의한다. 이 정책
하나를 실제로 강제하는 방식은
[`sandboxing/src/manager.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/sandboxing/src/manager.rs)의
`SandboxType`이 갈라놓는다.

```rust
pub enum SandboxType {
    None,
    MacosSeatbelt,
    LinuxSeccomp,
    WindowsRestrictedToken,
}
```

세 플랫폼이 쓰는 프리미티브가 서로 완전히 다르다는 걸 이름에서부터 알 수
있다. 하나씩 열어본다.

## macOS: Chrome의 샌드박스를 참고한 Seatbelt

`sandboxing/src/seatbelt_base_policy.sbpl`은 Apple의 Seatbelt
정책 언어(SBPL)로 쓴 파일이다. 첫 줄부터 태도가 명확하다.

```
(version 1)

; inspired by Chrome's sandbox policy:
; https://source.chromium.org/chromium/chromium/src/+/main:sandbox/policy/mac/common.sb

; start with closed-by-default
(deny default)

(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
```

기본은 전면 거부(`deny default`)고, 그 위에 필요한 것만 하나씩
`allow`로 뚫는다. 프로세스 실행/포크, 시그널(같은 샌드박스 안에서만),
`sysctl-read`로 CPU 정보 조회 같은 것들이 화이트리스트로 나열돼 있다.
심지어 Chromium 소스 코드 URL을 주석으로 남겨서 "이 정책이 어디서 영감을
받았는지"까지 밝혀 놨다. 브라우저 렌더러 프로세스를 가두는 데 쓰던
검증된 정책 언어를, 에이전트가 실행하는 셸 명령을 가두는 데 그대로
가져다 쓴 셈이다.

## Linux: 네임스페이스와 syscall 필터를 같이 쓴다

Linux 쪽은 두 메커니즘을 조합한다. `bwrap.rs`가 말하는 bubblewrap은
프로세스를 새 마운트/네트워크 네임스페이스에 가둬서 파일시스템과 네트워크
뷰 자체를 제한하고, `landlock.rs`가 다루는 landlock/seccomp은 그 안에서
허용된 syscall과 경로를 더 세밀하게 제어한다. 두 층이 겹쳐야 "격리된
프로세스이면서 그 안에서도 세밀한 권한 통제가 되는" 샌드박스가 나온다.

이 조합이 실전에서 얼마나 까다로운지가 `bwrap.rs`의 상수들에 그대로
드러난다.

```rust
pub(crate) const WSL1_BWRAP_WARNING: &str = concat!(
    "Codex's Linux sandbox uses bubblewrap, which is not supported on WSL1 ",
    "because WSL1 cannot create the required user namespaces. ",
    "Use WSL2 for sandboxed shell commands."
);
const USER_NAMESPACE_FAILURES: [&str; 4] = [
    "loopback: Failed RTM_NEWADDR",
    "loopback: Failed RTM_NEWLINK",
    "setting up uid map: Permission denied",
    "No permissions to create a new namespace",
];
```

WSL1은 유저 네임스페이스 자체를 못 만들어서 아예 지원 대상에서 빠진다.
시스템에 `bwrap`이 없으면 번들된 바이너리로 폴백하고, 그마저도 컨테이너
환경 등에서 네임스페이스 생성이 막혀 있으면 위 네 가지 에러 문자열 중
하나로 실패한다는 걸 미리 알고 있다가 사용자에게 원인을 짚어준다. 커널
기능 하나에 의존하는 샌드박스가 얼마나 다양한 환경(WSL, 컨테이너, 제한된
클라우드 VM)에서 깨질 수 있는지를 실제로 부딪혀보고 쌓은 코드로 보인다.

## Windows: 컨테이너가 아니라 토큰에서 권한을 깎는다

Windows에는 리눅스 네임스페이스에 대응하는 표준 기능이 없다.
`windows-sandbox-rs/src/token.rs`를 보면 접근 방식 자체가 다르다는 게
바로 보인다 — Win32 보안 API를 직접 호출한다.

```rust
use windows_sys::Win32::Security::CreateRestrictedToken;
use windows_sys::Win32::Security::Authorization::SetEntriesInAclW;
use windows_sys::Win32::Security::AdjustTokenPrivileges;
```

`CreateRestrictedToken`은 지금 프로세스의 보안 토큰에서 특정 권한과 SID를
제거한 "제한된 토큰"을 새로 만드는 Win32 API다. 프로세스를 별도 네임스페이스에
가두는 게 아니라, 프로세스가 애초에 들고 시작하는 권한 자체를 깎아서
새로 실행하는 방식이다. 여기에 파일별 ACL(`SetEntriesInAclW`,
`EXPLICIT_ACCESS_W`)로 세부 경로 접근을 더하고, 네트워크 쪽은 WFP(Windows
Filtering Platform, `wfp.rs`)로 따로 제어한다. 세 플랫폼 중 유일하게
"프로세스를 격리된 공간에 넣는다"가 아니라 "프로세스가 가진 권한 자체를
줄인다"는 접근이다.

## 워크스페이스 안에도 성역이 있다

`WorkspaceWrite` 정책이 작업 디렉터리를 통째로 쓰기 허용해도, 그 안의
모든 파일이 다 열려 있는 건 아니다.
[`protocol/src/protocol.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/protocol/src/protocol.rs#L1059)의
`WritableRoot` 구조체 주석이 이유를 설명한다.

> This is primarily used to ensure that folders containing files that could
> be modified to escalate the privileges of the agent (e.g. `.codex`,
> `.git`, notably `.git/hooks`) under a writable root are not modified by
> the agent.

`.git/hooks`를 콕 집은 이유가 분명하다. 에이전트가 워크스페이스 쓰기
권한을 갖고 있다고 해서 `.git/hooks/pre-commit`에 임의 스크립트를 심을 수
있으면, 다음에 아무 개발자가(혹은 에이전트 자신이) `git commit`을 실행하는
순간 샌드박스 밖에서 그 스크립트가 실행된다 — 전형적인 권한 상승 경로다.
그래서 워크스페이스 전체를 쓰기 허용하더라도 이런 하위 경로는 별도
읽기 전용 목록에 넣는다. [3편](/posts/codex-harness-tool-system/)에서 본
Guardian·훅과 마찬가지로, 이것도 모델이 "이 파일은 건드리면 안 되지"라고
판단해주길 기대하는 게 아니라 코드가 애초에 못 건드리게 막아 놓은
사례다.

## 정리

| 층 | 담당 코드 |
| --- | --- |
| 정책 정의(OS 중립) | `protocol/protocol.rs`의 `SandboxPolicy` |
| 구현 갈래 | `sandboxing/manager.rs`의 `SandboxType` |
| macOS 구현 | Seatbelt, `.sbpl` 프로필(default-deny) |
| Linux 구현 | bubblewrap(네임스페이스) + landlock/seccomp(syscall/경로) |
| Windows 구현 | `CreateRestrictedToken` + ACL + WFP |
| 쓰기 허용 안의 예외 | `WritableRoot`의 `.git/hooks` 등 권한 상승 방지 경로 |

한 문장으로 요약하면: **정책은 코드 한 군데서만 정의하고, 그 정책을
"실제로 못 벗어나게 강제하는 방법"은 OS마다 있는 걸 그대로 쓴다.**
프롬프트로 "위험한 명령은 실행하지 마"라고 아무리 잘 써도 도달할 수 없는
층이, [지난 글](/posts/harness-engineering/)에서 말했던 "모델의 판단과
무관하게 작동하는" 지점이다.

## 다음 편(마지막)

이 시리즈의 마지막 편이다. 지금까지 본 개별 조각들 — 에이전트 루프, 도구
실행, 샌드박스 — 을 감싸는 프로토콜과 상태 저장 계층을 본다.
`protocol.rs`의 이벤트 스키마, `rollout/`(세션 기록·재개), 그리고 Codex가
스스로 MCP 서버로도 동작하면서 동시에 다른 MCP 서버를 소비하는 양방향
구조를 열어본다.
