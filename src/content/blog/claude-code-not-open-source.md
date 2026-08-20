---
title: 'Claude Code는 오픈소스가 아니다 — SDK를 열어보니 얘기가 달라졌다'
description: '"Claude Code, 오픈소스로 공개돼 있잖아?"라는 말을 듣고 저장소를 직접 열어봤다. 소스는 없었지만, 그 대신 클로즈드소스 CLI와 대화하는 방법을 통째로 공개한 SDK가 있었다.'
pubDate: 2026-08-21T09:14:22+09:00
tags: ['ai-agent', 'harness', 'claude-code', 'open-source']
draft: true
---

"Claude Code, 오픈소스로 공개돼 있잖아? 깃헙에 말이야." 이런 얘기를 몇 번 들었다.
매일 쓰는 도구인데 정작 어떻게 동작하는지는 모른 채로 있었던 게 걸려서, 이번
기회에 직접 저장소를 열어봤다.

결론부터 말하면 아니었다. 그런데 "아니다"로 끝내기엔 아까운 발견이 있었다 —
CLI 자체는 비공개인데, 그 CLI와 대화하는 방법을 통째로 공개해 둔 SDK가 따로
있었다. 이 시리즈는 그 SDK와 CLI 저장소를 코드 레벨로 읽어서, 겉으로 드러나지
않는 Claude Code의 설계를 재구성해본 기록이다.

## 저장소 두 개, 완전히 다른 용도

Anthropic이 GitHub에 올려둔 저장소부터 정리하면 이렇다.

| 저장소 | 실제 내용물 | 라이선스 |
|---|---|---|
| [`anthropics/claude-code`](https://github.com/anthropics/claude-code) | 이슈 트래커, 설치 스크립트, 공식 플러그인, `.claude/commands`, 훅·설정·엔터프라이즈 예제 | all rights reserved — 오픈소스 아님 |
| [`anthropics/claude-agent-sdk-python`](https://github.com/anthropics/claude-agent-sdk-python) | CLI를 서브프로세스로 구동하는 Python 래퍼의 전체 소스 | MIT |
| `anthropics/claude-agent-sdk-typescript` | 같은 것의 TypeScript 버전 | 동일 계열 |

`claude-code` 저장소를 열면 `README.md`가 이렇게 안내한다.

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

CLI 본체는 컴파일된 바이너리로 설치될 뿐, 저장소 안에는 추론 루프도 도구
구현도 없다. `LICENSE.md`에는 "© Anthropic PBC. All rights reserved."라고
명시돼 있다. 즉 이 저장소는 **버그 리포트·플러그인·문서용 껍데기**다.

반면 `claude-agent-sdk-python`은 진짜 오픈소스다. MIT 라이선스고, 코드도 전부
읽을 수 있다. 그런데 그 코드를 열어보면 한 줄짜리 docstring이 정체를
밝혀버린다.

```python
# _internal/transport/subprocess_cli.py
"""Subprocess transport implementation using Claude Code CLI."""
```

SDK는 엔진이 아니라 **엔진을 호출하는 리모컨**이다. `query()` 함수 하나를
호출하면 내부적으로 벌어지는 일은 이렇다.

1. 옵션 객체를 CLI 커맨드라인 인자 배열로 직렬화한다.
2. `claude --output-format stream-json --input-format stream-json ...` 형태로
   서브프로세스를 띄운다.
3. stdin으로 JSON을 흘려보내고, stdout에서 줄 단위 JSON 스트림을 읽는다.
4. 각 줄을 타입이 있는 Python 객체로 파싱한다.

SDK 자체의 [README](https://github.com/anthropics/claude-agent-sdk-python#readme)도
이 구조를 숨기지 않는다.

> "The Claude Code CLI is automatically bundled with the package - no separate
> installation required!"

## 그런데 리모컨의 배선도는 꽤 많은 걸 알려준다

"엔진은 안 보인다"로 끝날 이야기였으면 이 시리즈를 쓰지도 않았을 것이다.
흥미로운 지점은 여기부터다 — 엔진과 대화하는 **계약**은 전부 타입으로
정의돼 있고, 그 계약을 코드로 짜다 보면 팀은 어쩔 수 없이 자기가 실제로
부딪힌 문제와 선택한 답을 주석으로 남기게 된다.

가장 먼저 확인한 건 CLI의 실제 플래그 표면이다. `subprocess_cli.py`가 옵션
객체의 각 필드를 커맨드라인 인자로 바꾸는 부분을 읽으면, 문서화되지 않은
부분까지 포함한 플래그 전체가 드러난다.

| 플래그 | 대응 옵션 | 의미 |
|---|---|---|
| `--tools` / `--allowedTools` / `--disallowedTools` | `tools`, `allowed_tools`, `disallowed_tools` | "존재하는 도구"와 "묻지 않고 자동승인할 도구"가 분리된 2단 구조 |
| `--permission-mode` | `permission_mode` | `default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto` |
| `--max-turns`, `--max-budget-usd`, `--task-budget` | 각각 | 턴 수·달러 예산·서브에이전트 태스크 단위 토큰 예산이 전부 따로 있다 |
| `--continue` / `--resume=` / `--fork-session` | 세션 계열 | 이어가기·재개·**포크**가 명확히 구분된 1급 기능 |
| `--resume-session-at=`, `--resume-drops-turn=` | 세션 계열 | 세션 안의 특정 지점으로 되감기까지 지원 |
| `--mcp-config`, `--strict-mcp-config` | `mcp_servers` | strict 모드는 프로젝트 설정·플러그인 MCP를 전부 무시 |

디테일 두 개가 특히 눈에 띄었다.

**`--resume`는 두 토큰이 아니라 `--resume=값`으로 합쳐 보낸다.** 주석에
이유가 적혀 있다 — CLI가 `--resume`을 "값이 optional인 플래그"로 선언해서,
두 토큰으로 보내면 값이 별도 인자처럼 씹힐 수 있다는 것이다. CLI 자체의
argv 파서 설계까지 간접적으로 드러나는 대목이다.

**Windows `cmd.exe` 인젝션을 명시적으로 방어한다.**

```python
_CMD_EXE_METACHARACTERS = '&|<>^%!"'
```

크로스플랫폼 서브프로세스 실행기를 실제로 프로덕션에서 굴려본 팀만 남기는
종류의 주석이다.

## 설정 하나에도 위계가 있다

플래그 목록보다 더 중요했던 건, 이게 "기능 나열"이 아니라 **레이어드
정책**이라는 점이다. 옵션 객체(`ClaudeAgentOptions`)의 docstring을 읽으면
곳곳에서 이 위계가 보인다.

도구는 존재 여부(`tools`) → 자동승인 여부(`allowed_tools`) → 완전차단
여부(`disallowed_tools`)로 3단이다. "허용 목록에 있다고 도구가 생기는 게
아니다"라고 docstring이 못박아둔다. 커스텀 권한 콜백(`can_use_tool`)의
평가 순서도 명시돼 있다 — 이미 `allowed_tools`나 `bypassPermissions`로
허용된 호출에는 이 콜백이 아예 호출되지 않는다. 이 순서를 오해해서 "콜백을
등록했는데 왜 안 불리지" 하는 실수가 실제로 있었을 것 같다 — 그걸 막으려고
전용 경고 클래스(`CanUseToolShadowedWarning`)까지 만들어 뒀다.

그리고 `extra_args: dict[str, str | None]`이라는 필드가 따로 있다. SDK가
아직 타입으로 감싸지 못한 CLI 플래그를 그대로 흘려보내는 탈출구다. 이
필드의 존재 자체가 "CLI의 실제 플래그 표면은 SDK의 타입 정의보다 항상
더 넓다"는 걸 스스로 인정하는 셈이다.

## 다음 편

여기까지가 "무엇이 실제로 공개돼 있는가"다. 다음 편은 권한 프롬프트에 뜨는
"Claude가 foo.txt를 읽으려 합니다" 같은 문장이 실제로 어디서 만들어지는지,
훅 10종류가 어떤 순서로 도는지, 샌드박스와 권한 규칙이 왜 서로 다른 축으로
분리돼 있는지를 다룬다.

*이 시리즈는 [`anthropics/claude-code`](https://github.com/anthropics/claude-code)와
[`anthropics/claude-agent-sdk-python`](https://github.com/anthropics/claude-agent-sdk-python)
저장소를 GitHub API로 직접 받아 코드를 읽고 쓴 기록이다. 인용된 코드는 각
저장소의 라이선스(SDK는 MIT, `claude-code`는 all-rights-reserved 문서 성격)를
따른다.*
