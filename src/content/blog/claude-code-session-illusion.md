---
title: 'CLI는 원격 저장소라는 걸 모른다'
description: '커스텀 세션 저장소를 붙이면 CLI가 그걸 아는 줄 알았다. 코드를 열어보니 SDK가 진짜 ~/.claude처럼 생긴 임시 디렉터리를 만들어서 CLI를 속이고 있었다.'
pubDate: 2026-08-21T13:02:41+09:00
tags: ['ai-agent', 'harness', 'claude-code', 'agent-sdk']
draft: true
---

[지난 글](/posts/claude-code-permission-model/)에서 권한·훅·샌드박스를
뜯어봤다. 이번엔 세션 차례다. Claude Code SDK는 `session_store`라는 옵션으로
자체 DB 같은 걸 세션 저장소로 꽂을 수 있게 해준다. 그런데 CLI는
클로즈드소스고, 애초에 "저장소를 플러그로 갈아끼운다"는 개념 자체를 알고
있을 리가 없다. 그래서 이게 실제로 어떻게 동작하는지 `_internal` 아래
세션 관련 파일 7개, 4,400줄 넘게 열어봤다.

## CLI를 속이는 방법

가장 중요한 발견이다. `session_store`로 커스텀 저장소를 넣어서 세션을
재개하면, SDK는 그걸 CLI에게 "전달"하지 않는다. 대신
[`session_resume.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/session_resume.py)의
`materialize_resume_session()`이 이렇게 한다.

1. `SessionStore`에서 세션 엔트리(JSONL)를 읽어온다.
2. **진짜 `~/.claude`처럼 생긴 임시 디렉터리**를 만들어서 그 안에 세션
   파일·인증 정보·설정을 그대로 써넣는다.
3. 서브프로세스의 `CLAUDE_CONFIG_DIR` 환경변수를 이 임시 디렉터리로
   가리키게 한다.
4. CLI는 자기가 로컬 디스크에서 평범하게 세션을 재개한다고 믿는다.
5. 세션이 끝나면 임시 디렉터리를 정리한다.

즉 **"플러그 가능한 세션 저장소"는 CLI 안에 있는 기능이 아니라, SDK가
클로즈드소스 바이너리를 속이려고 바깥에서 통째로 흉내 낸 파일시스템
착시다.**
[`sessions.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/sessions.py)(2,024줄)를
보면 로컬 디스크 기준 함수(`list_sessions`, `get_session_messages`,
`list_subagents`...) 하나마다 `_from_store` 버전이 나란히 존재한다 — 이
착시를 완전하게 만들려고 SDK 팀은 저장소 종류별로 사실상 같은 기능을 두
번씩 구현해야 했다.

## 트릭 하나에 방어 코드가 넷

임시 디렉터리 트릭 자체는 영리하지만, 그게 보안 구멍이 되지 않게 하려고
붙은 방어 코드가 더 흥미로웠다.

- 임시 디렉터리로 복사되는 `.credentials.json`은 **`refreshToken` 필드를
  제거한 버전**이다. 리프레시 토큰은 새 액세스 토큰을 계속 발급받을 수
  있는 장기 키인데, 정리가 실패할 수도 있는 임시 경로엔 아예 안 남긴다.
- 임시 디렉터리에 쓰는 모든 파일은 `0o600`(소유자만 읽기/쓰기)로
  생성된다.
- macOS에서는 Keychain에서 OAuth 자격증명을 읽어오는 폴백 경로도 있다.
- `_strip_settings_for_resume`는 재개용 임시 디렉터리에서 **플러그인
  마켓플레이스 선언을 제거**한다. 주석에 이유가 그대로 적혀 있다 —
  "그대로 두면 플러그인 캐시가 항상 비어있는 임시 디렉터리 기준으로
  재조정을 시도해서, 재개할 때마다 선언된 마켓플레이스를 네트워크로
  재설치하려 든다." 실제로 겪은 버그를 고친 흔적이 코드에 그대로 남아있는
  사례다.

리프레시 토큰 제거, 파일 권한 제한, 재시도 가능한 삭제, 부작용 있는 설정
필터링 — 전부 "플러그형 세션 저장소"라는 기능 하나를 안전하게 만들기 위한
비용이다.

## 미러링은 최선을 다하되, 지금 응답은 절대 막지 않는다

`--session-mirror` 플래그가 켜지면, CLI 서브프로세스는 stdout에
`{"type": "transcript_mirror", ...}` 프레임을 정상 메시지 사이사이에 끼워
보낸다.
[`TranscriptMirrorBatcher`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/transcript_mirror_batcher.py)는
이걸 모아뒀다가 턴이 끝날 때(`result` 메시지 도착) 플러시하거나, 버퍼가
500개 항목·1MiB를 넘으면 백그라운드에서 미리 플러시한다 — 모듈 docstring의
표현을 그대로 빌리면 "모델 스트리밍 중인 핫 패스에서 어댑터 지연을 떼어놓기
위해서"다.

실패 정책도 명확하다. 최대 3번 재시도하되 **타임아웃은 재시도하지
않는다** — 이미 날아간 요청이 서버에 도착해서 처리될 수도 있는데, 거기에
재시도까지 얹으면 중복 기록이 생기기 때문이다. 그리고 이 모든 재시도가
실패해도 예외를 던지지 않는다.

> "Failures never raise — the local-disk transcript is already durable so
> the session must continue unaffected."

**로컬 디스크가 진실의 원천이고, 원격 미러링은 부가 기능**이라는 위계가
명확하다. 많은 시스템이 "저장에 실패하면 일단 막고 본다"는 안전 제일
원칙을 쓰는데, 여기선 정반대다 — 사용자가 지금 보고 있는 응답의 연속성이
저장소 동기화의 완결성보다 우선한다.

## 프로토콜에 숨어 있던 기능들

세션 파일을 읽다가 CHANGELOG나 공식 문서만 봐서는 몰랐을 기능들도
발견했다. 전부
[`message_parser.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/message_parser.py)를
정독하다 나온 것들이다.

**일부 도구는 로컬이 아니라 서버에서 실행된다.** 어시스턴트 메시지의
콘텐츠 블록엔 `tool_use`(클라이언트가 실행) 말고 `server_tool_use` /
`advisor_tool_result`가 따로 있다. 클라이언트 실행형 도구와 호스티드
도구가 프로토콜 레벨에서부터 다른 종류로 취급된다는 뜻이다.

**백그라운드 태스크는 통짜 라이프사이클을 갖고 있다.** `task_started` →
`task_progress`(사용량 포함) → `task_notification`(상태·요약·출력 파일
경로) → `task_updated`(최종 상태 패치) 네 종류의 시스템 메시지가 있고,
`stop_task()`로 도중에 멈출 수도 있다. 세션 하나 안에 작은 잡 큐가 내장된
구조다.

**사용량 인지가 프로토콜 안에 내장돼 있다.** `rate_limit_event` 메시지는
`status`, `resetsAt`, `overageStatus`까지 실어 나른다. 에이전트 루프
자체가 "지금 요금제 한도에 얼마나 가까운가"를 실시간으로 안다는 뜻이다.

**알 수 없는 메시지는 조용히 무시한다.**

```python
case _:
    # Forward-compatible: skip unrecognized message types so newer
    # CLI versions don't crash older SDK versions.
    return None
```

CLI는 지금 버전이 v2.x인데 SDK는 v1.y일 수 있다는 걸 설계 시점부터
기본값으로 상정했다.

## `/context` 뒤에는 회계 장부가 있다

CLI의 `/context` 명령이 보여주는 컨텍스트 사용량 시각화는, SDK 레벨에서는
구조화된 데이터로 그대로 노출된다.

```python
class ContextUsageResponse(TypedDict):
    maxTokens: int             # autocompact 버퍼를 뺀 실효 최대치
    memoryFiles: list[dict]    # CLAUDE.md와 메모리 파일들 — 경로/토큰 수
    mcpTools: list[dict]       # MCP 도구별 토큰 비용
    agents: list[dict]         # 서브에이전트 정의별 토큰 비용
    deferredBuiltinTools: NotRequired[list[dict]]  # 지연 로드되는 빌트인 도구
    systemPromptSections: NotRequired[list[dict]]  # 섹션 단위 시스템 프롬프트
```

`SystemPromptPreset`의 docstring엔 "per-user dynamic sections(working
directory, **auto-memory**, git...)를 벗겨낸다"는 문구가 있다 — 시스템
프롬프트가 단일 문자열이 아니라, 매 턴 동적 섹션들을 조립해서 만드는
파이프라인이라는 뜻이다.

가장 의미 있는 지점은, **메모리·MCP 도구·서브에이전트 정의·스킬이 전부
"컨텍스트 예산을 쓰는 경쟁자"로 회계 처리된다**는 것이다. 확장 기능을
추가할수록 공짜가 아니라 컨텍스트 윈도라는 유한 자원을 다른 기능과 나눠
쓰게 된다는 걸 시스템이 스스로 계측한다. `deferredBuiltinTools`(지연
로드되는 빌트인 도구)의 존재는, 이 계측이 모니터링을 넘어 "당장 안 쓰는
도구 스키마는 프롬프트에 안 넣는다"는 실제 최적화로 이어진다는 증거다.

## 다음 편

세션은 임시 디렉터리로 흉내 낼 수 있었지만, 모든 게 그렇게 우회 가능한 건
아니었다. 마지막 편은 CLI가 자기 안에서 "이 턴이 진짜 끝났는가"를 판단하는
코드를 다룬다. 실제 이슈 번호까지 인용하며 "완전한 해법이 아니라
완화책"이라고 스스로 인정한 부분이 있었다 — 범용 에이전트를 만든다면
반드시 마주치는 질문이라, 거기서 시리즈를 마무리하려 한다.
