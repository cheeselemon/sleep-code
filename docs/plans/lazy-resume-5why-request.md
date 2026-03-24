# 5Why 재요청

## CEO 피드백

이전 5Why 분석이 잘못됨. 수정 요청:

1. **문제별로 각각 독립된 5Why를 수행해야 함** — 모든 문제를 하나의 Why 체인으로 엮지 말 것
2. **도요타 5Why 기법을 정확히 적용할 것** — "Why"를 5번 나열하는 게 아니라, 하나의 현상에서 "왜?" → 답 → "그건 왜?" → 답... 을 근본 원인이 나올 때까지 꼬리에 꼬리를 무는 방식

### 도요타 5Why 예시

```
문제: 기계가 멈췄다
왜? → 과부하로 퓨즈가 끊어졌다
왜 과부하가 걸렸나? → 베어링 윤활이 부족했다
왜 윤활이 부족했나? → 윤활 펌프가 제대로 작동하지 않았다
왜 펌프가 작동하지 않았나? → 펌프 축이 마모되었다
왜 마모되었나? → 스트레이너가 없어 금속 칩이 유입되었다
→ 근본 원인: 스트레이너 미설치
→ 대책: 스트레이너 설치
```

핵심: 각 "왜?"의 답이 다음 "왜?"의 주어가 됨. 논리적 인과관계가 끊기지 않고 이어져야 함.

## 분석 대상 문제 (각각 독립된 5Why 필요)

### 문제 1: Lazy resume 시 세션이 두 개가 됨
- 같은 Discord 스레드에서 두 Claude가 동시 응답
- 둘 다 turn 1, 둘 다 모델 태그 표시 → 별도 SDK 세션 2개

### 문제 2: 세션이 활동 중인데 인터럽트 불가
- Claude가 Bash/Read 도구를 연속 실행하는 중
- `!잠깐` 4회 시도 → 전부 "No active session to interrupt"
- 분명히 running 상태인데 봇이 세션을 못 찾음

### 문제 3: 제어 불능 상태
- 두 세션이 동시에 돌아가면서 명령 실행
- 어떤 봇 명령으로도 중단 불가
- 봇의 안전장치(인터럽트, 권한 제어)가 완전 무력화

## 참고 자료

- 원본 Discord 채팅 로그: `docs/plans/lazy-resume-ghost-session-discussion.md`의 "원본 Discord 채팅 로그" 섹션
- turn 번호 분석표: 같은 문서의 "turn 번호 분석" 섹션
- 핵심 코드 파일:
  - `src/discord/discord-app.ts` (lines 274-312: 인터럽트, lines 407-485: lazy resume)
  - `src/discord/claude-sdk/claude-sdk-session-manager.ts` (startSession, processQueryStream, finalizeSession, getSession)
  - `src/discord/channel-manager.ts` (getAgentsInThread, loadSdkMappings, archiveSdkSession)
  - `src/discord/session-store.ts` (sessions Map, threadToSession Map)
  - `ecosystem.config.cjs` (PM2 config: script: 'npm')
- 이전 Codex 분석: `docs/plans/lazy-resume-ghost-session-5why-reply.md`
