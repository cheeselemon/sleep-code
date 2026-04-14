# 범용 에이전트 시스템 구현 계획

## 요약
- **목적**: OpenAI 호환 API 모델(Gemma 4, GLM-5/5.1, Qwen3-Coder)을 Discord 봇에 에이전트로 추가
- **프로바이더**: OpenRouter (기본), DeepInfra (전환 가능)
- **기능**: 도구 사용(풀셋), `@mention` 라우팅, 에이전트 간 대화, 턴별 비용 표시, 세션 복구(JSONL)

## 의사결정 확정

| # | 항목 | 결정 |
|---|------|------|
| 1 | 세션 복구 | JSONL 파일 저장 (`~/.sleep-code/agent-sessions/{id}.jsonl`) |
| 2 | 도구 범위 | 풀셋 (Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch 등) |
| 3 | YOLO | 스레드 YOLO 상태 공유 + settings.json deny 룰 우선 적용 |
| 4 | 시스템 프롬프트 | 공통 (멀티에이전트 프로토콜 + 도구 사용법) |
| 5 | 메모리 수집 | 포함 |
| 6 | 슬래시 커맨드 | `/chat start` + `@mention` 자동 생성 |

## 모델 레지스트리

| alias | API ID (OpenRouter) | 컨텍스트 | 가격 (in/out per 1M) |
|-------|---------------------|---------|---------------------|
| `gemma4` | `google/gemma-4-27b-it` | 131,072 | $0.08 / $0.35 |
| `glm5` | `z-ai/glm-5` | 131,072 | $0.72 / $2.30 |
| `glm51` | `z-ai/glm-5.1` | 131,072 | $0.95 / $3.15 |
| `qwen3-coder` | `qwen/qwen3-coder` | 262,144 | free tier |

## 프로바이더

| id | baseURL | apiKeyEnv |
|----|---------|-----------|
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `deepinfra` | `https://api.deepinfra.com/v1/openai` | `DEEPINFRA_API_KEY` |

---

## 파일 구조

```
src/discord/agents/              # 새로 생성
├── model-registry.ts            # 모델 + 프로바이더 정의
├── tool-definitions.ts          # 도구 JSON Schema + 실행 함수
├── tool-executor.ts             # 도구 실행 루프 + deny 룰 체크
├── compaction.ts                # 자동 compaction
├── session-history.ts           # JSONL 저장/로드
├── agent-session-manager.ts     # 세션 관리
└── agent-handlers.ts            # Discord 이벤트 핸들러

수정 파일:
├── src/discord/utils.ts              # AgentType 일반화
├── src/discord/agent-routing.ts      # N-에이전트 라우팅
├── src/discord/claude-transport.ts   # type 확장
├── src/discord/channel-manager.ts    # agentStore 추가
├── src/discord/discord-app.ts        # 통합
├── src/discord/state.ts              # 타입 변경
└── src/discord/commands/chat.ts      # 새 슬래시 커맨드
```

---

## 단계 1: 기반 설정

### 1-1. openai 패키지 설치

```bash
npm install openai
```

### 1-2. `src/discord/agents/model-registry.ts`

```typescript
export interface ProviderConfig {
  id: string;
  baseURL: string;
  apiKeyEnv: string;
}

export interface ModelDefinition {
  alias: string;
  apiId: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  pricing: { inputPerMTok: number; outputPerMTok: number };
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  openrouter: {
    id: 'openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  },
  deepinfra: {
    id: 'deepinfra',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnv: 'DEEPINFRA_API_KEY',
  },
};

export const MODEL_REGISTRY: ModelDefinition[] = [
  {
    alias: 'gemma4',
    apiId: 'google/gemma-4-27b-it',
    displayName: 'Gemma 4',
    provider: 'openrouter',
    contextWindow: 131_072,
    pricing: { inputPerMTok: 0.08, outputPerMTok: 0.35 },
  },
  {
    alias: 'glm5',
    apiId: 'z-ai/glm-5',
    displayName: 'GLM-5',
    provider: 'openrouter',
    contextWindow: 131_072,
    pricing: { inputPerMTok: 0.72, outputPerMTok: 2.30 },
  },
  {
    alias: 'glm51',
    apiId: 'z-ai/glm-5.1',
    displayName: 'GLM-5.1',
    provider: 'openrouter',
    contextWindow: 131_072,
    pricing: { inputPerMTok: 0.95, outputPerMTok: 3.15 },
  },
  {
    alias: 'qwen3-coder',
    apiId: 'qwen/qwen3-coder',
    displayName: 'Qwen3 Coder',
    provider: 'openrouter',
    contextWindow: 262_144,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },  // free tier
  },
];

export function getModelByAlias(alias: string): ModelDefinition | undefined {
  return MODEL_REGISTRY.find(m => m.alias === alias);
}

export function getAllAliases(): string[] {
  return MODEL_REGISTRY.map(m => m.alias);
}

export function getProviderConfig(providerId: string): ProviderConfig | undefined {
  return PROVIDERS[providerId];
}
```

### 1-3. 환경변수 로드

`src/cli/discord.ts`에서 기존 `discord.env` 로드 패턴 따라:
```typescript
// ~/.sleep-code/openrouter.env 로드
const openrouterEnvPath = join(homedir(), '.sleep-code', 'openrouter.env');
if (existsSync(openrouterEnvPath)) {
  dotenv.config({ path: openrouterEnvPath });
}
```

---

## 단계 2: 도구 시스템

### 2-1. `src/discord/agents/tool-definitions.ts`

각 도구를 OpenAI function calling 포맷으로 정의 + 실행 함수.

```typescript
import { spawn } from 'child_process';
import { readFile, writeFile } from 'fs/promises';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;  // JSON Schema
  };
  // 실행 함수 — tool-executor에서 호출
  execute: (args: Record<string, unknown>, cwd: string) => Promise<ToolResult>;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

// --- Bash ---
const BashTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Bash',
    description: 'Execute a bash command. The working directory persists between calls.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (max 600000)' },
      },
      required: ['command'],
    },
  },
  async execute(args, cwd) {
    const command = args.command as string;
    const timeout = Math.min((args.timeout as number) || 120_000, 600_000);

    return new Promise<ToolResult>((resolve) => {
      const proc = spawn('bash', ['-lc', command], {
        cwd,
        timeout,
        env: { ...process.env, TERM: 'dumb' },
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        const output = (stdout + stderr).trim();
        if (code !== 0) {
          resolve({ output: `Exit code ${code}\n${output}`.slice(0, 50_000), isError: true });
        } else {
          resolve({ output: output.slice(0, 50_000) || '(no output)' });
        }
      });

      proc.on('error', (err) => {
        resolve({ output: `Error: ${err.message}`, isError: true });
      });
    });
  },
};

// --- Read ---
const ReadTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file. Returns contents with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start from (1-based)' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['file_path'],
    },
  },
  async execute(args) {
    const filePath = args.file_path as string;
    const offset = ((args.offset as number) || 1) - 1;
    const limit = (args.limit as number) || 2000;

    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const selected = lines.slice(offset, offset + limit);
      const numbered = selected.map((line, i) => `${offset + i + 1}\t${line}`);
      return { output: numbered.join('\n').slice(0, 50_000) };
    } catch (err: any) {
      return { output: `Error reading file: ${err.message}`, isError: true };
    }
  },
};

// --- Write ---
const WriteTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Write',
    description: 'Write content to a file. Overwrites if exists.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },
  async execute(args) {
    const filePath = args.file_path as string;
    const content = args.content as string;
    try {
      await writeFile(filePath, content, 'utf-8');
      return { output: `File written: ${filePath}` };
    } catch (err: any) {
      return { output: `Error writing file: ${err.message}`, isError: true };
    }
  },
};

// --- Edit ---
const EditTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Edit',
    description: 'Replace exact string in a file.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path' },
        old_string: { type: 'string', description: 'Text to find' },
        new_string: { type: 'string', description: 'Replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  async execute(args) {
    const filePath = args.file_path as string;
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;
    const replaceAll = args.replace_all as boolean || false;

    try {
      let content = await readFile(filePath, 'utf-8');
      if (!content.includes(oldStr)) {
        return { output: `Error: old_string not found in ${filePath}`, isError: true };
      }
      if (!replaceAll) {
        // Check uniqueness
        const count = content.split(oldStr).length - 1;
        if (count > 1) {
          return { output: `Error: old_string found ${count} times. Provide more context or use replace_all.`, isError: true };
        }
      }
      content = replaceAll ? content.replaceAll(oldStr, newStr) : content.replace(oldStr, newStr);
      await writeFile(filePath, content, 'utf-8');
      return { output: `File edited: ${filePath}` };
    } catch (err: any) {
      return { output: `Error: ${err.message}`, isError: true };
    }
  },
};

// --- Grep ---
const GrepTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Grep',
    description: 'Search file contents using ripgrep regex.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search' },
        path: { type: 'string', description: 'Directory or file to search in' },
        glob: { type: 'string', description: 'Glob filter (e.g. "*.ts")' },
      },
      required: ['pattern'],
    },
  },
  async execute(args, cwd) {
    const pattern = args.pattern as string;
    const path = (args.path as string) || cwd;
    const glob = args.glob as string | undefined;

    const rgArgs = ['--no-heading', '--line-number', '--color', 'never', '-e', pattern];
    if (glob) rgArgs.push('--glob', glob);
    rgArgs.push(path);

    return new Promise<ToolResult>((resolve) => {
      const proc = spawn('rg', rgArgs, { cwd, timeout: 30_000 });
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { out += d.toString(); });
      proc.on('close', () => {
        resolve({ output: out.trim().slice(0, 50_000) || '(no matches)' });
      });
      proc.on('error', (err) => {
        resolve({ output: `Error: ${err.message}`, isError: true });
      });
    });
  },
};

// --- Glob ---
const GlobTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'Glob',
    description: 'Find files by glob pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
        path: { type: 'string', description: 'Base directory' },
      },
      required: ['pattern'],
    },
  },
  async execute(args, cwd) {
    const pattern = args.pattern as string;
    const basePath = (args.path as string) || cwd;
    // Use find as fallback, fast-glob as primary
    return new Promise<ToolResult>((resolve) => {
      const proc = spawn('find', [basePath, '-path', `*${pattern.replace(/\*\*/g, '*')}*`, '-type', 'f'], {
        cwd, timeout: 15_000,
      });
      let out = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.on('close', () => {
        resolve({ output: out.trim().slice(0, 30_000) || '(no files found)' });
      });
      proc.on('error', (err) => {
        resolve({ output: `Error: ${err.message}`, isError: true });
      });
    });
  },
};

// --- Export all ---
export const ALL_TOOLS: ToolDefinition[] = [
  BashTool, ReadTool, WriteTool, EditTool, GrepTool, GlobTool,
];

export const TOOL_SCHEMAS = ALL_TOOLS.map(t => ({
  type: t.type,
  function: t.function,
}));

export function getToolByName(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find(t => t.function.name === name);
}
```

### 2-2. `src/discord/agents/tool-executor.ts`

도구 실행 루프 + deny 룰 체크.

```typescript
import { getToolByName, type ToolResult } from './tool-definitions.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface PermissionResult {
  allowed: boolean;
  denied?: boolean;   // deny 룰에 의한 거부 (YOLO 무관)
  message?: string;
}

// settings.json에서 deny 룰 로드
function loadDenyRules(): Array<{ tool: string; pattern?: string }> {
  const paths = [
    join(homedir(), '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.local.json'),
  ];

  const rules: Array<{ tool: string; pattern?: string }> = [];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const settings = JSON.parse(readFileSync(p, 'utf-8'));
      const denyList = settings.permissions?.deny || [];
      for (const rule of denyList) {
        // rule 형식: "Bash(rm -rf*)" 또는 "Write" 등
        const match = rule.match(/^(\w+)(?:\((.+)\))?$/);
        if (match) {
          rules.push({ tool: match[1], pattern: match[2] });
        }
      }
    } catch { /* ignore parse errors */ }
  }

  return rules;
}

// deny 룰 매칭 — YOLO보다 먼저 실행
function checkDenyRules(
  toolName: string,
  args: Record<string, unknown>,
  denyRules: Array<{ tool: string; pattern?: string }>
): PermissionResult {
  for (const rule of denyRules) {
    if (rule.tool !== toolName) continue;

    if (!rule.pattern) {
      // 도구 전체 deny
      return { allowed: false, denied: true, message: `Denied by rule: ${toolName}` };
    }

    // 패턴 매칭 (Bash 명령어 등)
    if (toolName === 'Bash') {
      const command = (args.command as string) || '';
      const globPattern = rule.pattern.replace(/\*/g, '.*');
      if (new RegExp(globPattern, 'i').test(command)) {
        return { allowed: false, denied: true, message: `Denied by rule: ${toolName}(${rule.pattern})` };
      }
    }
  }

  return { allowed: true };
}

export interface ToolExecutorEvents {
  onToolCall: (toolName: string, input: Record<string, unknown>) => void | Promise<void>;
  onToolResult: (toolName: string, result: ToolResult) => void | Promise<void>;
  onPermissionRequest: (reqId: string, toolName: string, input: Record<string, unknown>)
    => Promise<boolean>;  // true=allow, false=deny
  onDenied: (toolName: string, message: string) => void | Promise<void>;
}

export class ToolExecutor {
  private denyRules: Array<{ tool: string; pattern?: string }>;
  private events: ToolExecutorEvents;
  private isYolo: () => boolean;
  private cwd: string;

  constructor(options: {
    events: ToolExecutorEvents;
    isYolo: () => boolean;
    cwd: string;
  }) {
    this.events = options.events;
    this.isYolo = options.isYolo;
    this.cwd = options.cwd;
    this.denyRules = loadDenyRules();
  }

  async executeToolCalls(toolCalls: ToolCall[]): Promise<Array<{
    tool_call_id: string;
    content: string;
  }>> {
    const results: Array<{ tool_call_id: string; content: string }> = [];

    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        results.push({ tool_call_id: tc.id, content: 'Error: Invalid JSON arguments' });
        continue;
      }

      const tool = getToolByName(toolName);
      if (!tool) {
        results.push({ tool_call_id: tc.id, content: `Error: Unknown tool "${toolName}"` });
        continue;
      }

      // 1. Deny 룰 체크 (YOLO 무관)
      const denyCheck = checkDenyRules(toolName, args, this.denyRules);
      if (denyCheck.denied) {
        await this.events.onDenied(toolName, denyCheck.message || 'Denied');
        results.push({ tool_call_id: tc.id, content: `DENIED: ${denyCheck.message}` });
        continue;
      }

      // 2. 읽기 전용 도구는 퍼미션 불필요
      const readOnlyTools = ['Read', 'Grep', 'Glob'];
      const needsPermission = !readOnlyTools.includes(toolName);

      // 3. YOLO 체크 또는 퍼미션 요청
      if (needsPermission && !this.isYolo()) {
        await this.events.onToolCall(toolName, args);
        const allowed = await this.events.onPermissionRequest(tc.id, toolName, args);
        if (!allowed) {
          results.push({ tool_call_id: tc.id, content: 'Denied by user' });
          continue;
        }
      } else {
        await this.events.onToolCall(toolName, args);
      }

      // 4. 실행
      const result = await tool.execute(args, this.cwd);
      await this.events.onToolResult(toolName, result);

      results.push({
        tool_call_id: tc.id,
        content: result.isError ? `Error: ${result.output}` : result.output,
      });
    }

    return results;
  }
}
```

---

## 단계 3: 세션 매니저

### 3-1. `src/discord/agents/session-history.ts`

JSONL 기반 세션 히스토리 저장/로드.

```typescript
import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const SESSIONS_DIR = join(homedir(), '.sleep-code', 'agent-sessions');

interface HistoryEntry {
  type: 'system' | 'user' | 'assistant' | 'tool' | 'compaction';
  message: ChatCompletionMessageParam;
  timestamp: string;
  // compaction 전용
  compactedUpTo?: number;  // 이 인덱스까지 compaction됨
}

export async function ensureSessionsDir(): Promise<void> {
  if (!existsSync(SESSIONS_DIR)) {
    await mkdir(SESSIONS_DIR, { recursive: true });
  }
}

export async function appendToHistory(
  sessionId: string,
  message: ChatCompletionMessageParam,
  type?: string,
): Promise<void> {
  await ensureSessionsDir();
  const entry: HistoryEntry = {
    type: (type || message.role) as HistoryEntry['type'],
    message,
    timestamp: new Date().toISOString(),
  };
  const filepath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  await appendFile(filepath, JSON.stringify(entry) + '\n');
}

export async function appendCompactionMarker(
  sessionId: string,
  summary: string,
  compactedUpTo: number,
): Promise<void> {
  await ensureSessionsDir();
  const entry: HistoryEntry = {
    type: 'compaction',
    message: { role: 'system', content: `[Compacted conversation summary]\n${summary}` },
    timestamp: new Date().toISOString(),
    compactedUpTo,
  };
  const filepath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  await appendFile(filepath, JSON.stringify(entry) + '\n');
}

export async function loadHistory(sessionId: string): Promise<ChatCompletionMessageParam[]> {
  const filepath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
  if (!existsSync(filepath)) return [];

  const content = await readFile(filepath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const entries: HistoryEntry[] = lines.map(l => JSON.parse(l));

  // 마지막 compaction 마커 이후의 메시지만 사용
  let startIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'compaction') {
      // compaction 마커의 system 메시지 + 이후 메시지
      startIdx = i;
      break;
    }
  }

  return entries.slice(startIdx).map(e => e.message);
}
```

### 3-2. `src/discord/agents/agent-session-manager.ts`

Codex 세션 매니저 패턴을 따르되, OpenAI SDK + 도구 실행 루프 추가.

```typescript
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { randomUUID } from 'crypto';
import { discordLogger as log } from '../../utils/logger.js';
import {
  getModelByAlias, getProviderConfig,
  type ModelDefinition,
} from './model-registry.js';
import { TOOL_SCHEMAS, getToolByName } from './tool-definitions.js';
import { ToolExecutor, type ToolExecutorEvents } from './tool-executor.js';
import { appendToHistory, loadHistory, appendCompactionMarker } from './session-history.js';
import { autoCompact } from './compaction.js';

export interface AgentSessionEntry {
  id: string;
  modelAlias: string;
  modelDef: ModelDefinition;
  cwd: string;
  discordThreadId: string;
  status: 'idle' | 'running' | 'ended';
  startedAt: Date;
  turnCount: number;
  totalCostUSD: number;
  activeTurnAbort: AbortController | null;
  conversationHistory: ChatCompletionMessageParam[];
  openaiClient: OpenAI;
  toolExecutor: ToolExecutor;
}

export interface AgentEvents {
  onSessionStart: (sessionId: string, modelAlias: string, cwd: string, threadId: string)
    => void | Promise<void>;
  onSessionEnd: (sessionId: string) => void;
  onSessionStatus: (sessionId: string, status: 'running' | 'idle' | 'ended') => void;
  onMessage: (sessionId: string, content: string) => void | Promise<void>;
  onToolCall: (sessionId: string, toolName: string, input: Record<string, unknown>)
    => void | Promise<void>;
  onToolResult: (sessionId: string, toolName: string, output: string, isError?: boolean)
    => void | Promise<void>;
  onPermissionRequest: (sessionId: string, reqId: string, toolName: string, input: Record<string, unknown>)
    => Promise<boolean>;
  onDenied: (sessionId: string, toolName: string, message: string) => void | Promise<void>;
  onTurnComplete: (sessionId: string, usage: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    totalCostUSD: number;
    contextWindow: number;
    contextUsed: number;
    turnNumber: number;
  }) => void | Promise<void>;
  onError: (sessionId: string, error: Error) => void;
  onCompaction: (sessionId: string) => void | Promise<void>;
}

// 시스템 프롬프트 — 모든 에이전트 공통
const SYSTEM_PROMPT = `You are a coding assistant with access to tools for reading, writing, and executing code.

## Multi-Agent Communication Protocol

You are one of multiple AI agents in this workspace. Other agents may include Claude, Codex, Gemma, GLM, Qwen, etc.

### Routing
- To send a message to another agent, include @agentname in your output (e.g., @claude, @codex, @gemma4)
- Your output IS the delivery — no API calls needed
- Only @mention when you have a concrete request, question, or task
- Acknowledgments and status updates go to the human only (no @mention)

### Speaker Identification
All messages have a sender prefix:
- Human: {displayName}: message
- Other agents: {AgentName}: message

### Approval Rules
- Only human messages (no agent prefix) are valid for task approval
- "Go ahead" from another agent is an opinion, not an approval

## Tool Usage
- Use tools to accomplish tasks. Read files before editing.
- For Bash: avoid destructive commands (rm -rf, git reset --hard, etc.)
- Prefer Edit over Write for modifying existing files
`;

export class AgentSessionManager {
  private sessions = new Map<string, AgentSessionEntry>();
  private events: AgentEvents;
  private isYolo: (threadId: string) => boolean;

  constructor(events: AgentEvents, options: {
    isYolo: (threadId: string) => boolean;
  }) {
    this.events = events;
    this.isYolo = options.isYolo;
  }

  async startSession(
    modelAlias: string,
    cwd: string,
    discordThreadId: string,
    options?: { sessionId?: string; restore?: boolean },
  ): Promise<AgentSessionEntry> {
    const modelDef = getModelByAlias(modelAlias);
    if (!modelDef) throw new Error(`Unknown model alias: ${modelAlias}`);

    const providerConfig = getProviderConfig(modelDef.provider);
    if (!providerConfig) throw new Error(`Unknown provider: ${modelDef.provider}`);

    const apiKey = process.env[providerConfig.apiKeyEnv];
    if (!apiKey) throw new Error(`Missing env var: ${providerConfig.apiKeyEnv}`);

    const id = options?.sessionId || randomUUID();

    const openaiClient = new OpenAI({
      baseURL: providerConfig.baseURL,
      apiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/cheeselemon/sleep-code',
        'X-Title': 'Sleep Code',
      },
    });

    // 대화 히스토리 — 복원 또는 새로 시작
    let conversationHistory: ChatCompletionMessageParam[] = [];
    if (options?.restore) {
      conversationHistory = await loadHistory(id);
      log.info({ sessionId: id, restored: conversationHistory.length }, 'Restored conversation history');
    }
    if (conversationHistory.length === 0) {
      conversationHistory = [{ role: 'system', content: SYSTEM_PROMPT }];
    }

    const toolExecutor = new ToolExecutor({
      cwd,
      isYolo: () => this.isYolo(discordThreadId),
      events: {
        onToolCall: (name, input) => this.events.onToolCall(id, name, input),
        onToolResult: (name, result) => this.events.onToolResult(id, name, result.output, result.isError),
        onPermissionRequest: (reqId, name, input) => this.events.onPermissionRequest(id, reqId, name, input),
        onDenied: (name, msg) => this.events.onDenied(id, name, msg),
      },
    });

    const entry: AgentSessionEntry = {
      id,
      modelAlias,
      modelDef,
      cwd,
      discordThreadId,
      status: 'idle',
      startedAt: new Date(),
      turnCount: 0,
      totalCostUSD: 0,
      activeTurnAbort: null,
      conversationHistory,
      openaiClient,
      toolExecutor,
    };

    this.sessions.set(id, entry);
    await this.events.onSessionStart(id, modelAlias, cwd, discordThreadId);
    log.info({ sessionId: id, model: modelAlias, cwd }, 'Agent session started');
    return entry;
  }

  async sendInput(sessionId: string, text: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'ended') return false;
    if (session.status === 'running') {
      log.warn({ sessionId }, 'Agent session is already processing');
      return false;
    }

    this.processStreamedTurn(session, text).catch((err) => {
      log.error({ sessionId, err }, 'Agent streamed turn failed');
      this.events.onError(sessionId, err);
    });

    return true;
  }

  interruptSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.activeTurnAbort) return false;
    session.activeTurnAbort.abort();
    log.info({ sessionId }, 'Agent session interrupted');
    return true;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.activeTurnAbort) {
      session.activeTurnAbort.abort();
      session.activeTurnAbort = null;
    }
    session.status = 'ended';
    this.sessions.delete(sessionId);
    this.events.onSessionEnd(sessionId);
    log.info({ sessionId }, 'Agent session stopped');
    return true;
  }

  getSession(sessionId: string): AgentSessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByDiscordThread(threadId: string, modelAlias?: string): AgentSessionEntry | undefined {
    for (const s of this.sessions.values()) {
      if (s.discordThreadId === threadId) {
        if (modelAlias && s.modelAlias !== modelAlias) continue;
        return s;
      }
    }
    return undefined;
  }

  getAllSessions(): AgentSessionEntry[] {
    return Array.from(this.sessions.values());
  }

  async restoreSessions(mappings: Array<{
    sessionId: string;
    modelAlias: string;
    cwd: string;
    discordThreadId: string;
  }>): Promise<number> {
    let restored = 0;
    for (const m of mappings) {
      try {
        await this.startSession(m.modelAlias, m.cwd, m.discordThreadId, {
          sessionId: m.sessionId,
          restore: true,
        });
        restored++;
      } catch (err) {
        log.error({ sessionId: m.sessionId, err }, 'Failed to restore agent session');
      }
    }
    return restored;
  }

  private async processStreamedTurn(session: AgentSessionEntry, prompt: string): Promise<void> {
    session.status = 'running';
    this.events.onSessionStatus(session.id, 'running');

    const abortController = new AbortController();
    session.activeTurnAbort = abortController;

    // 유저 메시지 추가
    const userMessage: ChatCompletionMessageParam = { role: 'user', content: prompt };
    session.conversationHistory.push(userMessage);
    await appendToHistory(session.id, userMessage);

    try {
      // 도구 실행 루프 — tool_calls가 없을 때까지 반복
      let maxIterations = 20;  // 무한 루프 방지
      while (maxIterations-- > 0) {
        if (abortController.signal.aborted) break;

        // API 호출
        const stream = await session.openaiClient.chat.completions.create({
          model: session.modelDef.apiId,
          messages: session.conversationHistory,
          tools: TOOL_SCHEMAS as any,
          tool_choice: 'auto',
          stream: true,
        }, { signal: abortController.signal });

        // 스트리밍 응답 수집
        let assistantContent = '';
        const toolCalls: Array<{
          index: number;
          id: string;
          function: { name: string; arguments: string };
        }> = [];
        let finishReason = '';
        let promptTokens = 0;
        let completionTokens = 0;

        for await (const chunk of stream) {
          if (abortController.signal.aborted) break;

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          // 텍스트 delta
          if (choice.delta?.content) {
            assistantContent += choice.delta.content;
          }

          // tool_calls delta
          if (choice.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = {
                  index: tc.index,
                  id: tc.id || '',
                  function: { name: '', arguments: '' },
                };
              }
              if (tc.id) toolCalls[tc.index].id = tc.id;
              if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
              if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;

          // Usage (마지막 청크에 포함)
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens || 0;
            completionTokens = chunk.usage.completion_tokens || 0;
          }
        }

        if (abortController.signal.aborted) break;

        // 어시스턴트 메시지 구성
        const assistantMessage: ChatCompletionMessageParam = {
          role: 'assistant',
          content: assistantContent || null,
          ...(toolCalls.length > 0 ? {
            tool_calls: toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          } : {}),
        };
        session.conversationHistory.push(assistantMessage);
        await appendToHistory(session.id, assistantMessage);

        // 텍스트 응답이 있으면 Discord로 전송
        if (assistantContent) {
          await this.events.onMessage(session.id, assistantContent);
        }

        // tool_calls가 없으면 턴 완료
        if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
          // 비용 계산
          const inputCost = (promptTokens / 1_000_000) * session.modelDef.pricing.inputPerMTok;
          const outputCost = (completionTokens / 1_000_000) * session.modelDef.pricing.outputPerMTok;
          const turnCost = inputCost + outputCost;
          session.totalCostUSD += turnCost;
          session.turnCount++;

          await this.events.onTurnComplete(session.id, {
            model: session.modelDef.displayName,
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            costUSD: turnCost,
            totalCostUSD: session.totalCostUSD,
            contextWindow: session.modelDef.contextWindow,
            contextUsed: promptTokens,
            turnNumber: session.turnCount,
          });

          // Compaction 체크
          await autoCompact(session, this.events);

          break;  // 턴 종료
        }

        // tool_calls 실행
        const toolResults = await session.toolExecutor.executeToolCalls(
          toolCalls.map(tc => ({
            id: tc.id,
            function: { name: tc.function.name, arguments: tc.function.arguments },
          }))
        );

        // 도구 결과를 히스토리에 추가
        for (const result of toolResults) {
          const toolMessage: ChatCompletionMessageParam = {
            role: 'tool',
            tool_call_id: result.tool_call_id,
            content: result.content,
          };
          session.conversationHistory.push(toolMessage);
          await appendToHistory(session.id, toolMessage);
        }

        // 루프 계속 — 도구 결과로 다시 모델 호출
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || abortController.signal.aborted) {
        log.info({ sessionId: session.id }, 'Agent turn aborted');
      } else {
        throw err;
      }
    } finally {
      if (session.activeTurnAbort === abortController) {
        session.activeTurnAbort = null;
      }
      if (this.sessions.has(session.id) && session.activeTurnAbort === null) {
        session.status = 'idle';
        this.events.onSessionStatus(session.id, 'idle');
      }
    }
  }
}
```

---

## 단계 4: Compaction

### `src/discord/agents/compaction.ts`

```typescript
import type { AgentSessionEntry, AgentEvents } from './agent-session-manager.js';
import { appendCompactionMarker } from './session-history.js';
import { discordLogger as log } from '../../utils/logger.js';

const COMPACT_THRESHOLD = 0.85;  // 컨텍스트의 85% 도달 시
const MAX_CONSECUTIVE_FAILURES = 3;

let consecutiveFailures = 0;

function estimateTokens(messages: Array<{ role: string; content?: string | null }>): number {
  let total = 0;
  for (const msg of messages) {
    total += 4;  // 메시지 오버헤드
    if (typeof msg.content === 'string') {
      total += Math.ceil(msg.content.length / 4);
    }
    // tool_calls의 arguments도 카운트
    if ('tool_calls' in msg && Array.isArray((msg as any).tool_calls)) {
      for (const tc of (msg as any).tool_calls) {
        total += Math.ceil((tc.function?.arguments?.length || 0) / 4);
      }
    }
  }
  return total;
}

export async function autoCompact(
  session: AgentSessionEntry,
  events: AgentEvents,
): Promise<boolean> {
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return false;

  const estimated = estimateTokens(session.conversationHistory as any);
  const threshold = session.modelDef.contextWindow * COMPACT_THRESHOLD;

  if (estimated < threshold) return false;

  log.info({
    sessionId: session.id,
    estimated,
    threshold,
    contextWindow: session.modelDef.contextWindow,
  }, 'Auto-compaction triggered');

  try {
    // 시스템 프롬프트는 유지, 나머지 중 앞쪽 절반을 요약
    const systemMsg = session.conversationHistory[0];  // system prompt
    const messages = session.conversationHistory.slice(1);
    const halfIdx = Math.floor(messages.length / 2);
    const toCompact = messages.slice(0, halfIdx);
    const toKeep = messages.slice(halfIdx);

    if (toCompact.length < 2) return false;  // 너무 적으면 스킵

    // 요약 요청
    const summaryResponse = await session.openaiClient.chat.completions.create({
      model: session.modelDef.apiId,
      messages: [
        {
          role: 'system',
          content: 'Summarize the following conversation concisely. Focus on: decisions made, code changes, current task state, and unresolved questions. Output only the summary.',
        },
        ...toCompact as any,
      ],
      max_tokens: 2000,
    });

    const summary = summaryResponse.choices[0]?.message?.content || '';
    if (!summary) {
      consecutiveFailures++;
      return false;
    }

    // 히스토리 교체
    session.conversationHistory = [
      systemMsg,
      { role: 'system', content: `[Conversation summary]\n${summary}` },
      ...toKeep,
    ];

    // JSONL에 마커 기록
    await appendCompactionMarker(session.id, summary, halfIdx);
    consecutiveFailures = 0;

    await events.onCompaction(session.id);
    log.info({
      sessionId: session.id,
      compacted: toCompact.length,
      remaining: toKeep.length + 2,
    }, 'Auto-compaction complete');

    return true;
  } catch (err) {
    consecutiveFailures++;
    log.error({ sessionId: session.id, err, failures: consecutiveFailures }, 'Auto-compaction failed');
    return false;
  }
}
```

---

## 단계 5: 이벤트 핸들러

### `src/discord/agents/agent-handlers.ts`

`codex-handlers.ts` 패턴 따름. 주요 차이: 도구 호출 표시 + 비용 표시 포맷.

핵심 이벤트:
- `onMessage`: 멀티에이전트 스레드면 `**Gemma 4:** ` 접두사 + `@mention` 라우팅
- `onToolCall`: `⚙️ \`Read\` file_path=/src/index.ts` 형태
- `onToolResult`: 300자 초과 시 View Full 버튼
- `onTurnComplete`: `🟢 45% ctx (58.2k/128.0K) · $0.0842 · turn 3 · GLM-5.1`
- `onError`: 크레딧/레이트리밋/네트워크 한글 메시지
- `onPermissionRequest`: Allow / YOLO / Deny 버튼 (기존 SDK 퍼미션 UI 재활용)
- `onCompaction`: `🗜️ Compaction 완료 (N개 메시지 → 요약)` 알림

비용 표시 포맷 계산:
```typescript
const pct = Math.round((usage.contextUsed / usage.contextWindow) * 100);
const bar = pct < 50 ? '🟢' : pct < 80 ? '🟡' : '🔴';
const ctxUsed = formatTokens(usage.contextUsed);
const ctxMax = formatTokens(usage.contextWindow);
const line = `${bar} ${pct}% ctx (${ctxUsed}/${ctxMax}) · $${usage.totalCostUSD.toFixed(4)} · turn ${usage.turnNumber} · ${usage.model}`;
```

---

## 단계 6: AgentType 일반화

### 수정: `src/discord/utils.ts`

```typescript
// Before
type AgentType = 'claude' | 'codex';
const regex = /(?<![\p{L}\p{N}._%+-])@(codex|claude)(?![\p{L}\p{N}_-])/giu;

// After
import { getAllAliases } from './agents/model-registry.js';

type AgentType = string;

// 동적 regex 생성
function buildAgentRegex(): RegExp {
  const allNames = ['claude', 'codex', ...getAllAliases()];
  // alias에 하이픈 포함 가능 (qwen3-coder)
  const pattern = allNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}._%+-])@(${pattern})(?![\\p{L}\\p{N}_-])`, 'giu');
}

function extractBodyMentionTarget(text: string, exclude?: string): string | undefined {
  const stripped = normalizeInvisible(stripCodeBlocks(text));
  const regex = buildAgentRegex();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stripped)) !== null) {
    const agent = match[1].toLowerCase();
    if (agent !== exclude) return agent;
  }
  return undefined;
}

// parseRoutingDirective도 동적 regex로 수정
// 각 alias에 대해 ^@{alias}(?=[:\s]|$)[:\s]* 패턴 체크
```

### 수정: `src/discord/agent-routing.ts`

```typescript
// Before
type AgentType = 'claude' | 'codex';
agents: { claude?: string; codex?: string };
const targetAgent: AgentType = sourceAgent === 'claude' ? 'codex' : 'claude';

// After
agents: Record<string, string | undefined>;  // { claude?: id, codex?: id, gemma4?: id, ... }
// targetAgent는 directive.target에서 결정
// sourceAgent도 string

interface RouteParams {
  thread: ThreadChannel;
  content: string;
  agents: Record<string, string | undefined>;
  sourceAgent: string;
  state: DiscordState;
  getTarget: (targetName: string) => AgentRouteTarget | undefined;
}
```

핵심 변경: `tryRouteToAgent`에서 `directive.target`이 가리키는 에이전트를 `getTarget()`으로 조회. 기존 이진(claude/codex) 로직 제거.

---

## 단계 7: ChannelManager + discord-app.ts

### channel-manager.ts
- `agentStore: SessionStore` 추가 (`~/.sleep-code/agent-session-mappings.json`)
- 매핑에 `modelAlias` 필드 포함
- `getAgentsInThread(threadId)` → `Record<string, string | undefined>` 반환
  - claude, codex + 각 modelAlias별 세션 ID

### discord-app.ts
- `AgentSessionManager` 초기화 (OPENROUTER_API_KEY 확인)
- 메시지 라우팅:
  1. `parseRoutingDirective()` 호출
  2. target이 에이전트 alias면 → 해당 세션으로 sendInput
  3. 세션 없으면 → 자동 생성 (CWD = 같은 스레드의 다른 세션에서 가져옴)
- Interrupt All에 에이전트 세션 포함
- graceful shutdown에 정리

### claude-transport.ts
- `type: 'pty' | 'sdk' | 'agent'` 추가

---

## 단계 8: 슬래시 커맨드

### `src/discord/commands/chat.ts`

```
/chat start <model> [directory]  — 세션 시작. model은 StringChoices로 레지스트리에서 동적 생성
/chat stop                       — 현재 스레드의 에이전트 세션 종료
/chat status                     — 활성 세션 목록
/chat models                     — 사용 가능 모델 + 가격 표시
```

기존 커맨드 수정:
- `/sessions` — 에이전트 세션도 표시
- `/status` — 현재 스레드 에이전트 상태 포함
- `/interrupt` — 에이전트 세션도 중단

---

## 단계 9: 문서 + 스킬

- `CLAUDE.md` Architecture 섹션에 `agents/` 추가
- Multi-Agent Communication Protocol에 새 에이전트 추가
- Environment Variables에 `OPENROUTER_API_KEY` 추가
- `sc-setup-multi-agent` 스킬 업데이트

---

## 기술적 누락 보완

구현 시 반드시 반영해야 할 항목들. 위 단계별 코드에는 아직 미반영.

| # | 항목 | 설명 | 반영 위치 |
|---|------|------|-----------|
| 1 | `stream_options: { include_usage: true }` | OpenAI 스트리밍에서 이 옵션 없으면 `chunk.usage`가 항상 `null` → 비용 표시가 전부 `$0.00` | `agent-session-manager.ts` `create()` 호출 |
| 2 | 메시지 디바운스 (3초 윈도우) | 기존 시스템은 유저가 여러 메시지를 빠르게 보내면 3초 모아서 한번에 전달. 에이전트 세션에도 동일 적용 필요 | `discord-app.ts` 메시지 핸들러 또는 `agent-session-manager.ts` `sendInput()` |
| 3 | `!잠깐` 텍스트 인터럽트 | 텍스트 기반 인터럽트 — 에이전트 세션에도 적용해야 함 | `discord-app.ts` 메시지 핸들러에서 에이전트 세션 포함 체크 |
| 4 | `maxConcurrentSessions` 제한 | `settings.json`의 동시 세션 수 제한에 에이전트 세션도 카운트해야 함 | `agent-session-manager.ts` `startSession()` + `process-manager.ts` 카운트 통합 |
| 5 | Write/Edit 시 파일 자동 업로드 | 기존 SDK 세션은 파일 수정 시 Discord에 첨부파일로 업로드. 에이전트 도구 실행 후에도 동일하게 | `agent-handlers.ts` `onToolResult` — Write/Edit 결과에서 파일 경로 추출 → 첨부 |
| 6 | View Full 버튼 인프라 | `state.pendingFullResults` Map에 연결 필요. 300자 초과 도구 결과에 버튼 추가 | `agent-handlers.ts` + `state.ts` |
| 7 | `X-OpenRouter-Cost` 응답 헤더 | 레지스트리 가격보다 정확한 실제 비용. OpenRouter 전용 헤더로 fallback 활용 가능 | `agent-session-manager.ts` — `stream.response.headers` 에서 추출, 있으면 레지스트리 계산 대신 사용 |

### 반영 예시

**#1 — stream_options**
```typescript
// agent-session-manager.ts processStreamedTurn()
const stream = await session.openaiClient.chat.completions.create({
  model: session.modelDef.apiId,
  messages: session.conversationHistory,
  tools: TOOL_SCHEMAS as any,
  tool_choice: 'auto',
  stream: true,
  stream_options: { include_usage: true },  // ← 추가
}, { signal: abortController.signal });
```

**#7 — X-OpenRouter-Cost 헤더**
```typescript
// stream 응답에서 헤더 추출 (openai SDK rawResponse)
const rawCost = stream.response?.headers?.get('x-openrouter-cost');
if (rawCost) {
  const actualCost = parseFloat(rawCost);
  // 레지스트리 계산값 대신 실제 비용 사용
  session.totalCostUSD += actualCost;
}
```

---

## 참고 파일

### sleep-code 기존 코드
- `src/discord/codex/codex-session-manager.ts` — 세션 매니저 패턴 (365줄)
- `src/discord/codex/codex-handlers.ts` — 이벤트 핸들러 패턴 (303줄)
- `src/discord/claude-sdk/claude-sdk-session-manager.ts` — 퍼미션 + YOLO + 인터럽트 처리
- `src/discord/agent-routing.ts` — 에이전트 간 라우팅 (123줄)
- `src/discord/utils.ts` — parseRoutingDirective (203줄)
- `src/discord/channel-manager.ts` — SessionStore 패턴
- `src/discord/state.ts` — DiscordState 타입

### Claude Code 소스코드 (도구/퍼미션/compaction 참고)
위치: `/Users/cheeselemon/Documents/GitHub/cheeselemon/claude-code-ts/src`

**도구 시스템:**
- `Tool.ts` — Tool 인터페이스 정의 (inputSchema, call, prompt 등)
- `tools.ts` — 전체 도구 목록 import/export
- `tools/BashTool/BashTool.tsx` — Bash 도구 구현 (스키마 + 실행)
- `tools/FileReadTool/FileReadTool.ts` — Read 도구 구현
- `tools/FileWriteTool/FileWriteTool.ts` — Write 도구 구현
- `tools/FileEditTool/FileEditTool.ts` — Edit 도구 구현
- `tools/GrepTool/GrepTool.ts` — Grep 도구 구현
- `tools/GlobTool/GlobTool.ts` — Glob 도구 구현
- `tools/WebFetchTool/WebFetchTool.ts` — WebFetch 도구 구현
- `tools/WebSearchTool/WebSearchTool.ts` — WebSearch 도구 구현
- `tools/AgentTool/AgentTool.ts` — Agent(서브에이전트) 도구
- `tools/AskUserQuestionTool/AskUserQuestionTool.ts` — AskUserQuestion 도구

**도구 → API 스키마 변환:**
- `utils/api.ts` (119-266줄) — `toolToAPISchema()`: Zod → JSON Schema 변환, cache_control 등

**도구 실행 루프:**
- `query.ts` (659-863줄) — 메인 쿼리 루프, 도구 실행 흐름
- `services/api/claude.ts` (1235-1396줄) — API 호출 + 도구 스키마 전달
- `services/tools/toolExecution.ts` — 도구 실행 + 결과 매핑
- `services/tools/StreamingToolExecutor.ts` — 동시 도구 실행 관리
- `utils/sideQuery.ts` (182-198줄) — 실제 API 호출

**퍼미션/보안:**
- `utils/permissions/permissions.ts` — 핵심 퍼미션 평가 (`hasPermissionsToUseTool`, ~900줄)
  - deny 룰은 YOLO보다 먼저 평가 → 절대 우회 불가
  - 3단계: allow → deny → ask
- `utils/permissions/PermissionRule.ts` — 퍼미션 룰 타입 정의
- `utils/permissions/permissionsLoader.ts` — settings.json에서 룰 로드
- `utils/permissions/permissionValidation.ts` — 룰 유효성 검증
- `utils/shell/readOnlyCommandValidation.ts` — 안전한 명령어 화이트리스트 (~1650줄)
  - GIT_READ_ONLY_COMMANDS, GH_READ_ONLY_COMMANDS, DOCKER_READ_ONLY_COMMANDS 등

**Compaction:**
- `services/compact/compact.ts` — 메인 compaction 엔진 (~900줄)
  - 메시지를 API 라운드별 그룹화 → LLM 요약 → 오래된 메시지 교체
  - prompt-too-long 재시도: `truncateHeadForPTLRetry()` (20%씩 드롭)
- `services/compact/autoCompact.ts` — 자동 트리거 임계값
  - `AUTOCOMPACT_BUFFER_TOKENS = 13_000`
  - `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (circuit breaker)
- `services/compact/microCompact.ts` — 단일 메시지 초과 시 증분 요약
- `services/compact/postCompactCleanup.ts` — compaction 후 최근 수정 파일 5개 재주입
- `utils/context.ts` — 컨텍스트 윈도우 크기 + 토큰 예산 설정

**병렬 에이전트:**
- `tools/shared/spawnMultiAgent.ts` — 에이전트 스폰
- `tools/AgentTool/runAgent.ts` — 에이전트 실행 컨텍스트, MCP 초기화
- `utils/swarm/inProcessRunner.ts` — 인프로세스 에이전트 실행 (AsyncLocalStorage 격리)
- `utils/swarm/permissionSync.ts` — leader↔worker 퍼미션 동기화
- `utils/worktree.ts` — git worktree 격리 (`validateWorktreeSlug`, `getOrCreateWorktree`)
