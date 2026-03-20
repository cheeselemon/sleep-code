# Claude Agent SDK - TypeScript API Reference

구현 시 참고용. Context7에서 수집한 최신 공식 문서 기반.

## 설치

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## `query()` — 핵심 함수

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// 단일 프롬프트
for await (const message of query({
  prompt: "Hello Claude!",
  options: { /* Options */ }
})) {
  // message: SDKMessage
}

// 멀티턴 (async generator)
async function* promptGenerator() {
  yield { type: "user" as const, message: { role: "user" as const, content: "First message" } };
  // ... 다음 메시지 yield
}

for await (const message of query({
  prompt: promptGenerator(),
  options: { /* Options */ }
})) {
  // ...
}
```

반환: `AsyncGenerator<SDKMessage, void>` (+ 추가 메서드)

## Options 주요 필드

```typescript
interface Options {
  // 세션
  sessionId?: string;              // 특정 UUID 사용
  resume?: string;                 // 세션 ID로 재개
  continue?: boolean;              // 최근 대화 이어가기
  forkSession?: boolean;           // resume 시 새 세션 ID로 분기
  persistSession?: boolean;        // 기본 true, false면 디스크 저장 안함
  cwd?: string;                    // 작업 디렉토리

  // 모델
  model?: string;                  // "sonnet", "opus", "haiku" 또는 풀 모델명
  fallbackModel?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';

  // 도구/퍼미션
  allowedTools?: string[];         // 자동 승인 도구 (e.g. ["Bash", "Read", "mcp__server__*"])
  disallowedTools?: string[];      // 항상 차단 (allowedTools보다 우선)
  canUseTool?: CanUseTool;         // 커스텀 퍼미션 콜백
  permissionMode?: PermissionMode; // 'default' | 'bypassPermissions' | ...
  allowDangerouslySkipPermissions?: boolean;

  // MCP
  mcpServers?: Record<string, McpServerConfig>;

  // 스트리밍
  includePartialMessages?: boolean; // StreamEvent 활성화

  // 제어
  maxTurns?: number;
  maxBudgetUsd?: number;
  abortController?: AbortController;

  // 기타
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  agents?: Record<string, AgentDefinition>;
  agent?: string;
  pathToClaudeCodeExecutable?: string;
  env?: Record<string, string | undefined>;
  debug?: boolean;
}
```

## SDKMessage 타입 (전체)

```typescript
type SDKMessage =
  | SDKAssistantMessage      // 완성된 응답
  | SDKUserMessage           // 유저 입력 에코
  | SDKResultMessage         // 최종 결과
  | SDKSystemMessage         // 세션 초기화
  | SDKPartialAssistantMessage // 스트리밍 (includePartialMessages 필요)
  | SDKCompactBoundaryMessage  // 컴팩트 발생
  | SDKStatusMessage         // 상태 변경
  | SDKHookStartedMessage    // 훅 시작
  | SDKHookProgressMessage   // 훅 진행
  | SDKHookResponseMessage   // 훅 응답
  | SDKToolProgressMessage   // 도구 진행
  | SDKAuthStatusMessage     // 인증 상태
  | SDKTaskNotificationMessage
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKFilesPersistedEvent
  | SDKToolUseSummaryMessage
  | SDKRateLimitEvent
  | SDKPromptSuggestionMessage;
```

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: "assistant";
  uuid: string;
  session_id: string;
  message: BetaMessage;           // Anthropic SDK의 메시지 객체
  parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError;
};

// message.content는 ContentBlock[] 형태:
// - { type: "text", text: "..." }
// - { type: "tool_use", id: "...", name: "...", input: {...} }
// - { type: "thinking", thinking: "..." }
```

### SDKResultMessage

```typescript
type SDKResultMessage = {
  type: "result";
  subtype: "success" | "error";
  result?: string;                // 최종 텍스트 결과
  session_id: string;
  // ...
};
```

### SDKUserMessage

```typescript
type SDKUserMessage = {
  type: "user";
  uuid?: string;
  session_id: string;
  message: MessageParam;          // { role: "user", content: "..." }
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
};
```

## CanUseTool 콜백

```typescript
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string;
  }
) => Promise<PermissionResult>;

type PermissionResult =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
      toolUseID?: string;
    }
  | {
      behavior: "deny";
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };
```

### 사용 예시 (Discord 버튼 연동용)

```typescript
canUseTool: async (toolName, input, { signal }) => {
  // YOLO 모드
  if (isYolo) return { behavior: "allow", updatedInput: input };

  // Discord에 버튼 전송하고 Promise로 대기
  return new Promise((resolve) => {
    const requestId = randomUUID();
    pendingPermissions.set(requestId, { resolve });
    postPermissionButtons(requestId, toolName, input);
    // 버튼 클릭 시 resolve({ behavior: "allow" }) 또는 resolve({ behavior: "deny", message: "..." })
  });
}
```

### AskUserQuestion 핸들링

```typescript
canUseTool: async (toolName, input) => {
  if (toolName === "AskUserQuestion") {
    // input.questions: Array<{ question, header, options, multiSelect }>
    // Discord에 선택 UI 전송 → 답변 수집
    const answers = await collectAnswersFromDiscord(input.questions);
    return {
      behavior: "allow",
      updatedInput: { questions: input.questions, answers }
    };
  }
  // ...
}
```

## 스트리밍

```typescript
for await (const message of query({
  prompt: "...",
  options: { includePartialMessages: true }
})) {
  if (message.type === "assistant") {
    // 완성된 응답
    for (const block of message.message.content) {
      if (block.type === "text") console.log(block.text);
      if (block.type === "tool_use") console.log(block.name, block.input);
    }
  }

  // 스트리밍 이벤트 (includePartialMessages: true 필요)
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      process.stdout.write(event.delta.text);
    }
  }

  if (message.type === "result") {
    if (message.subtype === "success") console.log("Done:", message.result);
    if (message.subtype === "error") console.error("Error");
  }
}
```

## MCP 서버 연결

```typescript
// 외부 프로세스
mcpServers: {
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
  }
}

// HTTP
mcpServers: {
  memory: {
    type: "http",
    url: "http://127.0.0.1:24242/mcp"
  }
}

// allowedTools로 MCP 도구 허용
allowedTools: ["mcp__filesystem__*", "mcp__memory__search"]
```

## v2 Preview: SDKSession (멀티턴 세션)

```typescript
// 아직 unstable_ prefix
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";

// 새 세션
const session: SDKSession = unstable_v2_createSession({ model: "sonnet" });
await session.send("Hello");
for await (const msg of session.stream()) { /* ... */ }
await session.send("Follow up");
for await (const msg of session.stream()) { /* ... */ }
session.close();

// 세션 재개
const resumed = unstable_v2_resumeSession(sessionId, { model: "sonnet" });

interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
}
```

**참고**: v2 API는 unstable이므로, 현재 구현은 v1 `query()` + async generator 패턴 사용 권장.
v2가 stable되면 `SDKSession`으로 마이그레이션 가능 (send/stream 패턴이 더 깔끔).
