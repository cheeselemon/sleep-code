# Claude Agent SDK Session Guide

## Overview

Sleep Code는 두 가지 방식으로 Claude 세션을 실행할 수 있습니다:

| | PTY (기존) | SDK (신규) |
|---|---|---|
| 시작 명령 | `/claude start` | `/claude start-sdk` |
| 프로세스 | 외부 CLI + Unix socket | 인프로세스 (Agent SDK) |
| 출력 수신 | JSONL 파일 워칭 (간접) | async iterable (직접) |
| 입력 전송 | socket → PTY stdin | async generator yield |
| 권한 처리 | hook 바이너리 → socket → daemon | `canUseTool` 콜백 (Promise) |
| 세션 재개 | CLI `--resume` | `resume: sdkSessionId` 옵션 (lazy resume: 봇 재시작 후 메시지 보내면 자동 복구) |
| 의존성 | node-pty, chokidar, Unix socket | `@anthropic-ai/claude-agent-sdk` |
| 인증 | CLI 상속 | `claude login` OAuth (Max 구독) |

**언제 SDK를 쓰나요?**

- PTY 없이 가벼운 구조를 원할 때
- node-pty 컴파일 이슈가 있을 때
- 구조화된 tool call/result을 직접 받고 싶을 때

**언제 PTY를 쓰나요?**

- `/background`, `/mode`, `/compact` 등 터미널 제어가 필요할 때
- 기존 워크플로우를 그대로 유지하고 싶을 때

---

## Quick Start

### 1. 사전 요구사항

```bash
# Claude Agent SDK 패키지 (이미 포함됨)
npm install @anthropic-ai/claude-agent-sdk

# Claude CLI 인증 (OAuth)
claude login
```

### 2. 세션 시작

Discord에서:

```
/claude start-sdk
```

→ 디렉토리 선택 드롭다운이 표시됩니다 (화이트리스트된 디렉토리 목록).

디렉토리를 선택하면 해당 스레드에 SDK 세션이 시작됩니다:

```
📡 Claude SDK ready
Directory: /Users/you/project
```

### 3. 메시지 보내기

스레드에 일반 메시지를 입력하면 Claude에게 전달됩니다. 멀티턴 대화가 자동으로 유지됩니다.

```
You: src/index.ts 파일을 분석해줘
Claude: (응답)
You: 리팩토링 제안해줘
Claude: (이전 컨텍스트를 유지한 채 응답)
```

### 4. 세션 종료

```
/claude stop
```

---

## Permission Handling (권한 처리)

SDK 세션에서 Claude가 도구를 사용하려 하면, Discord에 권한 요청 버튼이 표시됩니다:

```
🔐 Permission Request: Bash
`npm install express`

[Allow] [🔥 YOLO] [Deny]
```

| 버튼 | 동작 |
|------|------|
| **Allow** | 이번 요청만 허용 |
| **🔥 YOLO** | 이번 요청 허용 + 이후 모든 요청 자동 승인 |
| **Deny** | 거부 |

### YOLO Mode

`/yolo-sleep` 또는 YOLO 버튼으로 활성화합니다. 활성화되면:

- 모든 도구 호출이 자동 승인됩니다
- `🔥 **YOLO**: Auto-approved \`Bash\`` 알림이 표시됩니다
- `ExitPlanMode`은 YOLO에서도 제외됩니다

### Permission Timeout

5분 내 응답이 없으면 자동 거부됩니다:

```
⏰ Permission timed out: `Bash` — auto-denied
```

타임아웃은 `~/.sleep-code/settings.json`에서 조정 가능합니다:

```json
{
  "sdkPermissionTimeoutMs": 300000
}
```

---

## Tool Display (도구 표시)

SDK 세션은 도구 호출/결과를 구조화된 형태로 표시합니다.

### Tool Call (도구 호출)

```
🔧 Bash: `npm test`
🔧 Read: `/src/index.ts`
🔧 Grep: `handlePermission`
🔧 Write: `/src/new-file.ts`
```

### Tool Result (도구 결과)

- 짧은 결과: 인라인으로 표시
- 300자 초과: 잘린 미리보기 + **[View Full]** 버튼
- Write/Edit 도구: 파일이 Discord 첨부파일로 업로드

```
✅ Result:
```
PASS src/index.test.ts
  ✓ should work (3ms)
```
```

---

## Session Management (세션 관리)

### 세션 상태

| 상태 | 설명 |
|------|------|
| `idle` | 입력 대기 중 |
| `running` | Claude가 응답/도구 실행 중 (타이핑 표시) |
| `ended` | 세션 종료됨 |

### 명령어

| 명령 | SDK 지원 | 설명 |
|------|:--------:|------|
| `/claude start-sdk` | ✅ | SDK 세션 시작 |
| `/claude stop` | ✅ | 세션 종료 |
| `/claude status` | ✅ | 세션 목록 (📡 SDK / 🔧 PTY 구분) |
| `/interrupt` | ✅ | 현재 턴 중단 (세션은 유지) |
| `/yolo-sleep` | ✅ | YOLO 모드 토글 |
| `/panel` | ✅ | interrupt + YOLO 버튼 표시 |
| `/background` | ❌ | SDK 미지원 (터미널 전용) |
| `/mode` | ❌ | SDK 미지원 (터미널 전용) |
| `/compact` | ❌ | SDK 미지원 (SDK 자체 관리) |
| `/model` | ⚠️ | 다음 턴부터 적용 |

> **참고:** SDK 세션은 `settingSources: ['user', 'project', 'local']`로 시작되어 CLAUDE.md, `~/.claude/settings.json`, 프로젝트 `.claude/` 설정을 자동 로드합니다.

### Interrupt vs Stop

- **Interrupt** (`/interrupt`): 현재 턴만 중단. 세션은 `idle` 상태로 돌아가 다음 입력을 대기합니다.
- **Stop** (`/claude stop`): 세션 전체 종료. 대기 중인 권한 요청도 모두 자동 거부됩니다.

---

## Multi-Agent (멀티 에이전트)

SDK 세션도 Codex와 같은 스레드에서 공존할 수 있습니다.

### 메시지 라우팅

```
c: 이 코드 설명해줘       → Claude (SDK) 에게 전달
x: 테스트 실행해줘         → Codex 에게 전달
(접두사 없음)              → 마지막 활성 에이전트에게 전달
```

### 제한 사항

- 한 스레드에 PTY 세션과 SDK 세션이 동시에 존재할 수 없습니다
- `x:` 접두사로 Codex가 없는 스레드에 메시지하면 자동으로 Codex 세션이 생성됩니다

---

## Memory Integration (메모리 연동)

SDK 세션의 Claude 응답은 자동으로 메모리 파이프라인에 수집됩니다.

- `speaker: 'claude'`로 기록
- 프로젝트명은 세션의 작업 디렉토리(`cwd`)에서 추출
- 메모리 비활성화: `DISABLE_MEMORY=1` 환경변수

---

## Configuration (설정)

`~/.sleep-code/settings.json`:

```json
{
  "sdkDefaultModel": "sonnet",
  "sdkPermissionTimeoutMs": 300000,
  "sdkStreamingEnabled": false
}
```

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `sdkDefaultModel` | `"sonnet"` | SDK 세션 기본 모델 |
| `sdkPermissionTimeoutMs` | `300000` (5분) | 권한 요청 타임아웃 |
| `sdkStreamingEnabled` | `false` | 스트리밍 활성화 (실험적) |

환경변수:

```bash
DISABLE_SDK_SESSIONS=1    # SDK 세션 기능 비활성화
```

---

## Bot Restart & Lazy Resume (봇 재시작 & 자동 복구)

SDK 세션은 봇 재시작 후 **별도 명령 없이** 자동 복구됩니다.

### 동작 원리

1. 봇 시작 시 `sdk-session-mappings.json` 로드 → `sdkSessions` + `sdkPersistedMappings` 복원
2. Broken 매핑 자동 정리 (`sdkSessionId === sessionId`인 항목 제거, 스레드별 중복 제거)
3. 사용자가 기존 스레드에 메시지 보냄
4. Lazy resume 트리거: `query({ resume: sdkSessionId })` 로 JSONL 히스토리 로드
5. 대화 컨텍스트 유지한 채 응답

### ID 구분 (중요)

| ID | 용도 | 예시 |
|----|------|------|
| `sessionId` | Sleep Code 내부 (Discord thread 매핑) | `a8864f1b-...` |
| `sdkSessionId` | Claude Agent SDK (`query({ resume })` 에 사용) | `995b99cd-...` |

두 ID는 별개입니다. `sdkSessionId`는 SDK가 JSONL 파일명으로 사용하며, resume 시 이 값을 전달해야 합니다.

### Resume 실패 시

Lazy resume 실패 → 자동으로 fresh start 시도 → 그것도 실패 시 `/claude start-sdk`로 수동 시작 안내.

---

## Troubleshooting

### "No active session in this channel"

SDK 세션이 시작되지 않았거나 종료된 스레드에서 명령을 실행했을 때 발생합니다. 봇 재시작 후라면 메시지를 한 번 보내보세요 (lazy resume). 그래도 안 되면 `/claude start-sdk`로 새 세션을 시작하세요.

### OAuth 인증 오류

```bash
claude login    # CLI에서 다시 인증
```

SDK 세션은 Claude Max 구독의 OAuth 인증이 필요합니다.

### Permission이 계속 타임아웃됨

`sdkPermissionTimeoutMs` 값을 늘리거나, YOLO 모드를 사용하세요.

### `/background`, `/compact` 등이 동작하지 않음

이 명령들은 PTY 세션 전용입니다. SDK 세션에서는 지원되지 않습니다.

### 봇 재시작 후 응답이 안 옴

1. 메시지를 한 번 보내보세요 → lazy resume 트리거
2. 로그 확인: `pm2 logs sleep-discord --lines 30 --nostream`
3. `Lazy-resuming SDK session` 로그가 있으면 정상 (SDK 로딩 중)
4. `Fresh start also failed` 로그가 있으면 `/claude start-sdk`로 새 세션 시작

### 세션이 예기치 않게 종료됨

로그를 확인하세요:

```bash
pm2 logs sleep-discord    # PM2 사용 시
# 또는
npm run discord           # 직접 실행 시 콘솔 출력 확인
```

`Claude SDK query ended unexpectedly.` 메시지가 있으면 네트워크 문제이거나 SDK 자체 오류일 수 있습니다.
