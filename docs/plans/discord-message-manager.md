# 메시지 안정성 개선 계획

## 현재 컨텍스트 (2026-02-01)

### 핵심 문제
- Claude Code의 JSONL에 **일부 assistant 메시지가 기록되지 않음**
- 특히 **tool call 직후 짧은 텍스트 응답**이 누락됨
- 파일 감시 문제가 아님 - JSONL 자체에 기록이 안 되는 것이 원인

### 해결 방향
- JSONL만으로는 불가능 → **PTY stdout을 보조 소스로 활용**
- 두 소스에서 메시지를 받아 중복 제거 후 전송

### 구현 완료 항목
1. ✅ **chokidar 도입** - `36477ae` (문제 미해결 확인)
2. ✅ **strip-ansi 설치** - PTY output ANSI 제거용
3. ✅ **PtyOutputParser 구현** - `src/shared/pty-output-parser.ts`
4. ✅ **run.ts 수정** - `sendPtyOutput()` 메서드 추가, PTY 스트리밍
5. ✅ **session-manager.ts 수정** - `pty_output` 메시지 수신 및 중복 제거

### 다음 단계
- **claude 세션 재시작 필요** - run.ts 변경사항은 새 세션에서만 적용
- 테스트 후 문제 해결 확인
- 필요시 MessageAggregator 분리 및 Discord MessageQueue 추가

### 변경된 파일
| 파일 | 변경 내용 |
|------|----------|
| `src/shared/pty-output-parser.ts` | 신규 - PTY output 파싱, ANSI 제거, debounce |
| `src/cli/run.ts` | PtyOutputParser 사용, sendPtyOutput() 추가 |
| `src/slack/session-manager.ts` | chokidar 적용, pty_output 핸들러, 중복 제거 |
| `package.json` | strip-ansi 의존성 추가 |

---

## 상태

| Phase | 항목 | 상태 | 비고 |
|-------|------|------|------|
| 1.1 | chokidar 도입 | ✅ 완료 | 문제 해결 안 됨 - JSONL 자체 누락 확인 |
| 1.2 | MessageAggregator | ⏸️ 보류 | 현재 session-manager.ts에 인라인 구현 |
| 2.1 | ANSI Parser | ✅ 완료 | `src/shared/pty-output-parser.ts` |
| 2.2 | PTY stdout 스트리밍 | ✅ 완료 | run.ts에서 sendPtyOutput() |
| 2.3 | session-manager 수신 | ✅ 완료 | pty_output 핸들러 + 중복 제거 |
| 3 | Discord MessageQueue | ⏳ 대기 | 테스트 후 필요시 진행 |

## 문제
Claude Code의 JSONL에 일부 assistant 메시지가 기록되지 않음. 불완전한 줄 버퍼링으로도 해결 안 됨.

## 원인 분석
- Claude Code가 스트리밍 중 JSONL에 모든 내용을 기록하지 않는 경우 존재
- 특히 tool call 직후 짧은 텍스트 응답이 누락되는 패턴
- **2026-02-01 확인**: chokidar로 파일 감시 개선해도 해결 안 됨 → JSONL 자체에 기록이 안 되는 것이 원인

## 해결 전략: 다중 소스 통합

JSONL만으로는 부족하므로 PTY stdout을 보조 소스로 활용.

```
┌─────────────────────────────────────────────────────────────┐
│                      run.ts (PTY)                           │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │ PTY stdout  │───▶│ AnsiParser  │───▶│ Unix Socket │     │
│  │ (raw)       │    │ (정제)       │    │ (daemon)    │     │
│  └─────────────┘    └─────────────┘    └──────┬──────┘     │
└──────────────────────────────────────────────│─────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   session-manager.ts                        │
│  ┌─────────────┐    ┌──────────────────┐                   │
│  │ JSONL       │───▶│ MessageAggregator │                   │
│  │ (chokidar)  │    │ (First-Win +      │                   │
│  └─────────────┘    │  중복 제거)       │                   │
│  ┌─────────────┐    │                   │                   │
│  │ PTY stream  │───▶│                   │──▶ onMessage()    │
│  │ (socket)    │    └──────────────────┘                   │
│  └─────────────┘                                            │
└─────────────────────────────────────────────────────────────┘
                                               │
                         ┌─────────────────────┼─────────────────────┐
                         ▼                     ▼                     ▼
                   discord-app.ts        slack-app.ts        telegram-app.ts
                   (MessageQueue)        (기존 유지)          (기존 유지)
```

## 데이터 소스 상세

### 1. JSONL (Primary)
- **현재**: ~~fs.watch~~ → chokidar + 2초 polling + fs.readFile (✅ 완료)
- **제공**: 구조화된 메시지 (role, content, tool_use, tool_result, todos)
- **한계**: 일부 assistant 메시지가 JSONL에 아예 기록되지 않음 (파일 감시 문제 아님)

### 2. PTY stdout (Backup) ✅ 구현 완료
- **구현**: `src/shared/pty-output-parser.ts` + `run.ts` 수정
- **제공**:
  - 실시간 assistant 응답 텍스트 (strip-ansi로 정제)
  - Thinking 상태 (spinner 문자 감지)
  - 150ms debounce로 청킹
- **중복 제거**: content hash (앞 100자)로 JSONL/PTY 간 중복 방지
- **한계**:
  - 구조화 안 됨 (tool_use 등 구분 어려움) - JSONL에 의존
  - user input도 섞여있을 수 있음

## 구현 계획

### Phase 1: 기반 개선 (session-manager.ts)

#### 1.1 chokidar 도입 ✅ 완료 (2026-02-01)

**커밋**: `36477ae Replace fs.watch with chokidar for more reliable JSONL watching`

```typescript
// 적용된 코드
session.watcher = chokidar.watch(session.jsonlPath, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 100,  // 100ms 동안 변화 없으면 완료로 간주
    pollInterval: 50,
  },
});
```

**결과**: 파일 감시는 개선되었으나 메시지 누락 해결 안 됨
- tool call 직후 assistant 메시지가 여전히 누락
- JSONL 자체에 해당 메시지가 기록되지 않는 것으로 확인
- → Phase 2 (PTY stdout 스트리밍) 필요

#### 1.2 MessageAggregator 추가
```typescript
// src/shared/message-aggregator.ts
interface AggregatedMessage {
  id: string;           // hash(timestamp + content_prefix)
  source: 'jsonl' | 'pty';
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  delivered: boolean;
}

class MessageAggregator {
  private messages = new Map<string, AggregatedMessage>();
  private deliveryWindow = 2000; // 2초 내 중복 무시

  // JSONL에서 오면 바로 전달
  addFromJsonl(msg): boolean;

  // PTY에서 오면 JSONL에서 이미 온 건지 확인 후 전달
  addFromPty(msg): boolean;
}
```

### Phase 2: PTY stdout 스트리밍 ✅ 완료

#### 2.1 PtyOutputParser (src/shared/pty-output-parser.ts)
```typescript
// 실제 구현
export class PtyOutputParser {
  process(data: string): void {
    // 1. OSC title sequence 제거
    // 2. stripAnsi()로 ANSI escape 제거
    // 3. spinner 문자 제거
    // 4. 150ms debounce
    // 5. delta 계산 (이전 출력과 비교)
    // 6. onOutput 콜백 호출
  }
}
```

#### 2.2 run.ts - sendPtyOutput()
```typescript
// 실제 구현
sendPtyOutput(content: string, isThinking: boolean): void {
  this.socket.write(JSON.stringify({
    type: 'pty_output',
    sessionId: this.config.sessionId,
    content,
    isThinking,
    timestamp: Date.now(),
  }) + '\n');
}

// 사용
const ptyOutputParser = new PtyOutputParser((output) => {
  daemon.sendPtyOutput(output.content, output.isThinking);
});

ptyProcess.onData((data) => {
  ptyOutputParser.process(data);
});
```

#### 2.3 session-manager.ts - pty_output 핸들러
```typescript
// 실제 구현
case 'pty_output': {
  const content = message.content.trim();
  const contentHash = hash(content.slice(0, 100));
  const contentKey = `pty:${session.id}:${contentHash}`;

  if (!session.seenMessages.has(contentKey)) {
    this.addSeenMessage(session, contentKey);
    this.events.onMessage(session.id, 'assistant', content);
  }
  break;
}
```

**중복 제거 로직**: JSONL과 PTY 모두 동일한 `contentKey` 사용하여 먼저 도착한 메시지만 전송

### Phase 3: Discord MessageQueue (discord-app.ts)

Discord 특화 기능 (rate limit, retry)은 플랫폼별로 유지.

```typescript
// src/discord/message-queue.ts
class DiscordMessageQueue {
  private queue: QueuedMessage[] = [];
  private processing = false;

  async enqueue(msg: QueuedMessage): Promise<void>;
  private async processQueue(): Promise<void>;
  private async sendWithRetry(msg: QueuedMessage): Promise<void>;
}
```

## 구현된 파일들

### 새로 생성
1. ✅ `src/shared/pty-output-parser.ts` - PTY output 파싱 (strip-ansi, debounce, delta)

### 수정
1. ✅ `src/cli/run.ts` - PtyOutputParser 사용, sendPtyOutput() 추가
2. ✅ `src/slack/session-manager.ts` - chokidar + pty_output 핸들러 + 중복 제거
3. ✅ `package.json` - strip-ansi 추가

### 미구현 (필요시)
1. ⏳ `src/shared/message-aggregator.ts` - 현재 session-manager.ts에 인라인 구현됨
2. ⏳ `src/discord/message-queue.ts` - Discord rate limit/retry

## 구현 순서

1. ✅ **chokidar 도입** - session-manager.ts의 fs.watch 교체 (완료, 문제 미해결)
2. ✅ **PtyOutputParser** - PTY output 정제
3. ✅ **run.ts 수정** - pty_output 메시지 전송
4. ✅ **session-manager.ts 수정** - pty_output 수신 + 중복 제거
5. 🔄 **테스트** - claude 세션 재시작 필요
6. ⏳ **MessageAggregator 분리** - 필요시 별도 모듈로 분리
7. ⏳ **Discord MessageQueue** - rate limit/retry 필요시

## 검증 방법

1. Tool call 후 짧은 텍스트 응답 (이전에 누락되던 케이스)
2. 연속 빠른 메시지에서 누락 없는지 확인
3. PM2 재시작 후 정상 동작
4. Discord rate limit 시 재시도 확인

## 의존성

```json
{
  "dependencies": {
    "chokidar": "^5.0.0",    // ✅ 설치됨
    "strip-ansi": "^7.1.0"   // ✅ 설치됨
  }
}
```

## 리스크 및 대안

### PTY 파싱 복잡도 → ✅ 해결
- strip-ansi + 커스텀 파싱으로 구현 완료
- 150ms debounce로 과도한 이벤트 방지

### 중복 메시지 → ✅ 해결
- content hash (앞 100자) + seenMessages Set으로 중복 제거
- JSONL과 PTY 모두 동일한 key 형식 사용: `pty:{sessionId}:{hash}`

### 성능
- PTY output이 많을 경우 부하 가능
- 현재 대응: 150ms debounce, 50KB 버퍼 제한
- 추가 필요시: 더 긴 debounce 또는 sampling

### 테스트 필요
- claude 세션 재시작 후 실제 메시지 누락 해결 확인 필요
- tool call 직후 짧은 텍스트 응답 테스트
