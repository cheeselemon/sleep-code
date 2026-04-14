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
