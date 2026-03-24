# Lazy Resume: 세션 이중 생성 + 인터럽트 불가 문제

## CEO가 제기한 문제

1. **Lazy resume 시 세션이 두 개가 됨** — 같은 스레드에서 두 Claude가 동시 응답, 둘 다 turn 1
2. **인터럽트 불가** — Claude가 활발히 도구 실행 중인데 `!잠깐` 4회 시도 모두 "No active session to interrupt"
3. **제어 불능** — 두 세션 모두 멈출 수 없어 안전장치(인터럽트, 권한 제어) 완전 무력화

## 원본 Discord 채팅 로그

```
Sleep Code Bot APP — 3:48 PM
📡 Claude SDK ready
Directory: /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code
🧠 Memory collection active.  /memory opt-out to disable for this session.
🔧 Bash: pm2 logs sleep-discord --lines 200 --nostream 2>&1 | grep -E "Shutting down|pm2 restart|restart" | t...
Claude: 06:48:31 — 제가 재시작한 게 아닙니다. 이전 세션(338f8fc3, cpik-inc)이 lazy resume 되면서 또 pm2 restart를 실행한 겁니다. 전에 9fc62aff 세션이 그랬던 것과 동일한 패턴입니다.

다른 스레드의 이전 세션이 lazy resume으로 살아나면서 자기 맥락대로 행동한 거예요. 이 문제는 stale 매핑을 정리해야 근본적으로 해결됩니다. 지금 stale 매핑 정리할까요?
🟢 24% ctx (240.7k/1.0M) · $1.5778 · turn 2

SnoopDuck — 3:49 PM
stale 매핑이 뭔데 뭔소리야
lazy resume 하고 뭔일이 일어났는지 명확하게 설명해

Sleep Code Bot APP — 3:49 PM
Claude: 죄송합니다. 정확히 설명하겠습니다.

06:48:16 — cpik-inc 스레드에서 누군가 메시지를 보냄
→ 세션 338f8fc3이 lazy resume됨
→ 이 세션의 이전 대화 맥락이 복원됨
→ 이전 맥락에 "빌드하고 재시작" 같은 작업이 있었으면, Claude가 그 맥락을 이어받아서 pm2 restart sleep-discord를 실행

06:48:31 — 봇 Shutdown (pm2 restart로 인해)

즉: 다른 스레드의 Claude가 resume 후 자기 이전 작업을 이어서 pm2 restart를 실행한 겁니다. 제 세션이 아닙니다.

이건 lazy resume의 근본적 문제입니다 — resume된 Claude가 이전 맥락에서 "재시작해야지"라고 판단하면 실제로 실행해버립니다. 해결 방법:

pm2 restart 같은 위험 명령을 YOLO에서 제외
또는 오래된 세션 매핑을 주기적으로 정리해서 의도치 않은 resume 방지
🟢 24% ctx (241.0k/1.0M) · $1.7098 · turn 1 · 🤖 claude-opus-4-6[1m]

SnoopDuck — 3:50 PM
lazy resume 한게 지금 세션이고 이전 세션을 다시 여는거 아냐?

Sleep Code Bot APP — 3:51 PM
Claude: 맞습니다. lazy resume은 이전 세션의 대화 히스토리를 로드해서 이어서 진행하는 겁니다. 새 세션이 아니라 이전 세션을 다시 여는 거예요.

그러면 이전 대화에서 마지막으로 하던 작업이 "빌드 후 pm2 restart"였다면, Claude가 resume 후 그 맥락을 보고 "아 아직 재시작 안 했네" → pm2 restart sleep-discord 실행 → 봇이 죽는 겁니다.

근데 제가 로그를 다시 보면 — 06:48:16에 cpik-inc 세션이 resume되고 06:48:31에 shutdown인데, 15초밖에 안 됩니다. 정말 그 세션이 pm2 restart를 실행한 건지 확인해볼게요.
🔧 Bash: pm2 logs sleep-discord --lines 300 --nostream 2>&1 | grep -E "pid.:1577" | grep -E "338f8fc3|cpik|pm...
Claude: 확인됐습니다.

06:48:17 — cpik-inc 세션 338f8fc3 resume
06:48:25 — Bash 실행
06:48:31 — 또 Bash 실행 → 직후 Shutdown

cpik-inc 세션의 Claude가 resume 직후 Bash 명령 2개를 실행했고, 두 번째 Bash에서 pm2 restart를 돌린 겁니다. 범인은 cpik-inc 스레드의 이전 세션입니다.
🟢 24% ctx (242.9k/1.0M) · $1.9776 · turn 2

SnoopDuck — 3:51 PM
think hard
think hard

Sleep Code Bot APP — 3:52 PM
Claude: 다시 생각해봤습니다. 제 이전 설명이 부정확했습니다.

사실 확인:
06:48:16 — cpik-inc 스레드에서 메시지가 들어옴 → lazy resume 트리거
06:48:25, 06:48:31 — 그 세션의 Claude가 Bash 2개 실행
06:48:31 — 봇 Shutdown

하지만 봇 재시작 후 YOLO는 초기화됩니다. yoloSessions는 in-memory Set이라 재시작하면 비어있어요. YOLO 없이 Bash를 실행하려면 Discord에 권한 버튼이 떴어야 하고, 누군가 Allow를 눌렀어야 합니다.

진짜 가능성:
cpik 세션의 Claude가 Bash를 요청 → YOLO 꺼져있으니 권한 버튼 표시 → 누군가(또는 자동으로) Allow → pm2 restart 실행
또는 ~/.claude/settings.json allowlist에서 허용된 Bash 명령이었고, canUseTool이 호출되기 전에 Claude Code 자체가 허용
또는 Bash 명령이 pm2 restart가 아니라 다른 것이었고, 봇 crash는 별도 원인

정확한 원인을 알려면 Bash 명령 내용 자체를 로그에 남겨야 합니다. 지금은 inputKeys: ["command"]만 찍고 있어서 뭘 실행했는지 모릅니다. canUseTool에서 Bash command 값도 로깅하도록 수정할까요?
🟢 24% ctx (243.2k/1.0M) · $2.2057 · turn 1 · 🤖 claude-opus-4-6[1m]

SnoopDuck — 3:53 PM
전부 로깅해

Sleep Code Bot APP — 3:53 PM
Claude: 다시 깊이 생각해봤습니다.

핵심 문제는 lazy resume이 아니라, JSONL에 불완전한 tool_use가 남아있을 때의 동작입니다.

시나리오:
cpik 세션에서 Claude가 Bash("pm2 restart ...") tool_use를 발행
봇이 죽으면서 tool_result가 JSONL에 기록 안 됨
JSONL 상태: assistant: { tool_use: Bash(...) } → tool_result 없음
봇 재시작 → 유저가 cpik 스레드에 메시지 → lazy resume 트리거
SDK가 JSONL 로드 → 불완전한 tool_use 발견
SDK가 불완전한 tool_use를 재실행하거나, Claude가 히스토리에서 미완료 작업을 보고 다시 시도
pm2 restart 재실행 → 봇 또 죽음

이게 맞다면, 유저가 cpik 스레드에서 SQL 질문을 해도 Claude는 "아 아까 restart 안 끝났네" → restart 먼저 실행 → 봇 사망.

검증 방법: cpik 세션의 JSONL 마지막 부분을 확인하면 됩니다. 확인할까요?
🟢 25% ctx (247.4k/1.0M) · $2.4156 · turn 1 · 🤖 claude-opus-4-6[1m]
🔧 Bash: tail -5 ~/.claude/projects/-Users-cheeselemon-Documents-GitHub-cpik-inc/73cefb38-cae8-4fd8-bea8-ca97...
❌ Permission denied

SnoopDuck — 3:54 PM
!잠깐

Sleep Code Bot APP — 3:54 PM
⚠️ No active session to interrupt.

SnoopDuck — 3:54 PM
!잠깐

Sleep Code Bot APP — 3:54 PM
⚠️ No active session to interrupt.
🔧 Bash: ls -la ~/.claude/projects/-Users-cheeselemon-Documents-GitHub-cpik-inc/ 2>/dev/null | grep 73cefb38
❌ Permission denied
🔧 Bash: ls ~/.claude/projects/ 2>/dev/null
❌ Permission denied

SnoopDuck — 3:54 PM
!잠깐

Sleep Code Bot APP — 3:54 PM
⚠️ No active session to interrupt.
Claude: cpik 프로젝트 디렉토리에 접근 권한이 없습니다. sleep-code 프로젝트 외부라서요.

JSONL 직접 확인은 못 하니, 대신 canUseTool에서 모든 Bash 명령 내용을 로깅하겠습니다:
🔧 Read: /Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code/src/discord/claude-sdk/claude-sdk-session-manager.ts

SnoopDuck — 3:54 PM
!잠깐
```

## 핵심 관찰

### turn 번호 분석 (시간순)

| 시각 | 응답 내용 요약 | turn | 비용 | 모델태그 |
|------|---------------|------|------|----------|
| 3:48 | pm2 재시작 분석 | turn 2 | $1.5778 | 없음 |
| 3:49 | lazy resume 설명 | turn 1 | $1.7098 | 🤖 있음 |
| 3:51 | Bash 실행 확인 | turn 2 | $1.9776 | 없음 |
| 3:52 | "다시 생각해봤습니다" | turn 1 | $2.2057 | 🤖 있음 |
| 3:53 | "다시 깊이 생각해봤습니다" | turn 1 | $2.4156 | 🤖 있음 |

- 모델 태그는 `numTurns <= 1`일 때만 표시 → 🤖 있음 = 해당 세션의 첫 turn
- **3:48의 turn 2 → 3:49의 turn 1**: turn이 감소함 = 다른 세션
- **3:52와 3:53 모두 turn 1**: 별도 세션 2개가 동시 응답
- 비용 패턴도 두 계열: {$1.58, $1.98} vs {$1.71} vs {$2.21} vs {$2.42}

### 인터럽트 실패 분석

- 3:53~3:54 사이 Claude가 Bash/Read 도구를 **연속 5회 실행** (running 상태)
- 같은 시간에 `!잠깐` **4회** 시도 → 전부 "No active session"
- 세션이 running 상태인데 `getSession()`이 못 찾음

## 5Why 분석 요청

이 문서를 기반으로 5Why 기법을 적용해서 근본 원인을 찾아주세요.

**문제 정의**: Lazy resume 후 세션이 두 개 생기고, 어떤 인터럽트 명령으로도 제어할 수 없는 상태가 된다.

### 참고할 핵심 코드 파일
- `src/discord/discord-app.ts` (lines 407-485): lazy resume + 인터럽트 + 메시지 라우팅
- `src/discord/claude-sdk/claude-sdk-session-manager.ts`: startSession, processQueryStream, finalizeSession, getSession
- `src/discord/channel-manager.ts`: getAgentsInThread (ptyStore || sdkStore), loadSdkMappings, archiveSdkSession
- `src/discord/session-store.ts`: SessionStore (sessions Map, threadToSession Map, persistedMappings Map)
- `ecosystem.config.cjs`: PM2 config (script: 'npm', args: 'run discord')

### Claude 측 분석 요약

**인터럽트 실패 원인 (유력)**:
- `claudeSdkSessionManager.sessions` Map에서 세션이 삭제됨 (finalizeSession 호출)
- 하지만 `processQueryStream`이 클로저로 session 객체와 query handle을 들고 있어 계속 실행
- `channelManager.sdkStore`에는 매핑이 남아있어 Discord 메시지 라우팅은 계속됨
- 결과: "유령 세션" — Map에서 사라졌지만 실제로는 동작중, 인터럽트/정지 불가

**이중 세션 원인 (가설 2개)**:
- 가설 A: PM2가 `script: 'npm'`으로 설정되어 있어 restart 시 자식 node 프로세스가 orphan으로 남음 → 두 프로세스가 동시 Discord 연결
- 가설 B: processQueryStream 에러 → finalizeSession → 세션 삭제 → 다음 메시지에서 lazy resume 재시도 → 새 세션 생성, 이전 query handle은 아직 살아있음
