---
title: '코드로 읽는 Codex 하네스 (12) — 셸은 기억하고, 원격 채널은 양자 이후를 대비한다'
slug: codex-harness-shell-and-remote
category: ai
description: '시즌 2 마지막 편. 영속 셸 세션(shell_snapshot, unified_exec)과 원격 exec-server의 포스트퀀텀 하이브리드 암호화 채널을 열어보고 12편짜리 시리즈를 마무리했다.'
pubDate: 2026-08-22T21:30:00+09:00
tags: ['ai-agent', 'codex', 'harness', 'source-analysis']
draft: true
---

시즌 2 마지막 편이다. [7편](/posts/codex-harness-exec-policy/)부터
[11편](/posts/codex-harness-hooks/)까지 다섯 개 주제를 깊이 팠으니,
이번엔 작은 조각 둘 — 영속 셸 세션과 원격 실행 채널 — 을 짧게 훑고
12편짜리 시리즈 전체를 마무리한다. 커밋은 이 시리즈에서 계속 쓰는
[`3b45c29`](https://github.com/openai/codex/tree/3b45c29062ff0e76e71c91b6753290400e7fa8da)다.

## 셸도 "그 사람의" 셸이어야 한다

[`shell-command/src/shell_snapshot.rs`](https://github.com/openai/codex/blob/3b45c29062ff0e76e71c91b6753290400e7fa8da/codex-rs/shell-command/src/shell_snapshot.rs)는
셸 타입별로 "복원 가능한 셸 상태를 캡처하는 셸 네이티브 스크립트"를
만든다. zsh용 스크립트를 보면 이렇다.

```sh
if [[ -n "$ZDOTDIR" ]]; then
  rc="$ZDOTDIR/.zshrc"
else
  rc="$HOME/.zshrc"
fi
[[ -r "$rc" ]] && . "$rc"
print '# Snapshot file'
print 'unalias -a 2>/dev/null || true'
print '# Functions'
functions
```

사용자의 실제 `.zshrc`를 소싱한 다음, 그 안에서 정의된 함수와 alias를
전부 덤프한다. Codex가 명령을 실행할 때 사용자가 평소 쓰던 셸과 똑같은
alias·함수·환경 변수를 그대로 물려받게 하려는 것이다. `PWD`, `OLDPWD`는
export 목록에서 일부러 뺀다 — 작업 디렉터리는 스냅샷에 박아 넣을 게
아니라 매번 따로 관리해야 하는 값이라서다. Windows Command Prompt는
지원 대상에서 아예 빠진다 — 주석 그대로 "cmd.exe는 이 표현에 필요한
POSIX/PowerShell 상태를 노출하지 않는다."

## 명령 하나가 아니라 세션이다

`unified_exec` 도구는 명령을 한 번 실행하고 끝나는 게 아니다.
`core/src/tools/handlers/unified_exec/` 안에 `ExecCommandHandler`와
`WriteStdinHandler`가 따로 있다 — 하나는 셸 프로세스를 새로 시작하고,
다른 하나는 이미 떠 있는 프로세스에 표준 입력을 더 흘려보낸다. 인자에
`tty: bool`, `login: Option<bool>`, `yield_time_ms`가 있는 것도
같은 맥락이다. [8편](/posts/codex-harness-code-mode/)에서 본 Code
Mode의 `wait`/`yield_control()`과 정확히 같은 패턴이다 — 오래 걸리는
프로세스를 한 번에 끝까지 기다리지 않고, 중간중간 출력을 흘려주고
필요하면 나중에 다시 이어받는다. 대화형 셸을 다루는 방식과 오래 걸리는
스크립트를 다루는 방식이 하네스 안에서 같은 설계를 공유하고 있다.

## 원격 실행 채널은 양자 컴퓨터 이후까지 내다본다

1편에서 `exec-server`에 원격 실행을 위한 모듈이 있다고만 언급했는데,
그 채널을 실제로 여는 `noise_channel.rs`를 열어보고 놀랐다. 파일 맨
위 주석이다.

> The harness initiates hybrid IK and pins the exec-server static key
> returned by the registry. The first handshake message lets the
> exec-server authenticate the harness static key; the exec-server then
> asks the registry whether that key is authorized before completing the
> handshake.
>
> "Hybrid" means the session keys include both X25519 and ML-KEM-768 key
> agreement. Once the two-message handshake finishes, AES-GCM protects the
> ordered transport records carrying JSON-RPC.

핵심은 "Hybrid" 한 단어다. X25519는 지금 쓰이는 표준 타원곡선
키 교환이고, ML-KEM-768은 NIST가 표준화한 포스트퀀텀 키 캡슐화
알고리즘(옛 이름 Kyber)이다. 둘을 동시에 써서 세션 키를 만든다 — 둘 중
하나가 훗날 깨져도(예를 들어 충분히 강력한 양자 컴퓨터가 X25519를
깨거나, ML-KEM 자체에서 미발견 결함이 나오거나) 나머지 하나가 채널을
지켜주는 구조다. 로컬 하네스와 원격 실행 서버 사이의 통신 하나를
위해 포스트퀀텀 암호까지 넣어 둔 걸 보면, 이 원격 실행 경로가 단순
실험이 아니라 상당히 진지하게 다뤄지고 있다는 걸 알 수 있다.

인증 방식도 눈여겨볼 만하다. 그냥 키를 주고받는 게 아니라, exec-server가
하네스의 정적 키를 확인한 뒤 **레지스트리에 그 키가 승인됐는지 물어보고**
나서야 핸드셰이크를 완료한다. 채널을 암호화하는 것과, 그 채널 반대편이
정말 권한을 가진 하네스인지 확인하는 것을 별도 단계로 나눠 둔
셈이다.

## `cloud-tasks`는 또 다른 층이다

`cloud-tasks/` crate도 열어봤는데, 이건 하네스 내부 로직이라기보다
Codex Cloud에 올라간 작업을 CLI/TUI로 조회·생성하는 사용자 도구에
가까웠다(`cli.rs`, `ui.rs`, `new_task.rs`). README에서 언급했던 "Codex
Web"(클라우드 기반 에이전트)과 로컬 CLI 사이를 잇는 인터페이스로
보인다. 이 시리즈는 로컬에서 도는 에이전트 루프에 집중했으니, 여기서는
이런 층이 있다는 것만 표시해 두고 깊이 들어가지는 않는다.

## 열두 편을 마치며

1편은 지난 글에서 인용만 하고 넘어갔던 문장이 실제로 코드로 존재하는지
확인하는 걸 목표로 시작했다. 시즌 1(1~6편)에서 요청 하나가 흐르는
경로 — 에이전트 루프, 도구 실행, 파일 수정, 실행 격리, 프로토콜과
상태 — 를 끝까지 따라갔고, 시즌 2(7~12편)에서는 그 경로 밖에 있던
것들 — 승인 판정 로직, 스크립트 기반 도구 오케스트레이션, 멀티
에이전트, 멀티 프로바이더, 훅, 그리고 셸과 원격 채널까지 — 을 팠다.

열두 편을 관통하는 패턴은 결국 하나다. `git`은 인자만 보고는 절대
안전하다고 판단하지 않고, 워크스페이스를 통째로 쓰기 허용해도
`.git/hooks`는 별도로 막고, 서브 에이전트 역할은 부모의 권한을 절대
넘어설 수 없고, 훅 스크립트는 내용이 바뀌면 다시 신뢰를 물어야 한다.
전부 "모델이나 사용자가 그 순간 뭘 하려고 하든, 시스템이 이미 정해둔
경계 안에서만 움직인다"는 같은 원칙의 다른 얼굴이었다. 하네스
엔지니어링이라는 말을 코드로 열어봤더니, 매 편마다 같은 문장이 다른
파일에 다른 모습으로 적혀 있었던 셈이다.
