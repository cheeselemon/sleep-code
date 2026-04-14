import { getToolByName, type ToolResult } from './tool-definitions.js';
import { readFileSync, existsSync, realpathSync } from 'fs';
import { join, resolve, relative, isAbsolute, dirname } from 'path';
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

// ── CWD 경로 제한 (Claude Code 패턴) ──────────────────────────
// posix.relative()로 상대경로 계산 → ".." 포함 시 CWD 밖으로 판정

function normalizeMacOS(p: string): string {
  return p
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1');
}

function containsPathTraversal(p: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(p);
}

/**
 * 경로가 CWD 안에 있는지 판정 (Claude Code 패턴)
 * 1. 상대경로는 세션 cwd 기준으로 resolve
 * 2. symlink가 있으면 실제 대상도 체크 (둘 다 CWD 안이어야 허용)
 */
function pathInCwd(targetPath: string, cwd: string): boolean {
  // 상대경로를 세션 cwd 기준으로 resolve (봇 프로세스 cwd가 아닌)
  const absTarget = normalizeMacOS(
    isAbsolute(targetPath) ? resolve(targetPath) : resolve(cwd, targetPath)
  );
  const absCwd = normalizeMacOS(resolve(cwd));

  // lexical check
  const checkPath = (p: string): boolean => {
    const rel = relative(absCwd, p);
    if (rel === '') return true;
    if (containsPathTraversal(rel)) return false;
    return !isAbsolute(rel);
  };

  if (!checkPath(absTarget)) return false;

  // symlink 실제 대상도 체크
  // 파일이 존재하면 직접 realpath, 없으면 가장 깊이 존재하는 조상 디렉토리의 realpath
  // (Write로 symlink 디렉토리 아래에 새 파일을 쓰는 케이스 방어)
  try {
    let pathToResolve = absTarget;
    if (!existsSync(absTarget)) {
      // 가장 깊이 존재하는 조상 찾기
      let ancestor = dirname(absTarget);
      for (let depth = 0; depth < 40; depth++) {
        if (existsSync(ancestor)) { pathToResolve = ancestor; break; }
        const parent = dirname(ancestor);
        if (parent === ancestor) break; // root
        ancestor = parent;
      }
    }
    if (existsSync(pathToResolve)) {
      const realResolved = normalizeMacOS(realpathSync(pathToResolve));
      if (!checkPath(realResolved)) return false;
    }
  } catch { /* 접근 불가 — lexical check만으로 판단 */ }

  return true;
}

/**
 * 도구 인자에서 경로를 추출 (Read.file_path, Write.file_path, Edit.file_path, Grep.path, Glob.path)
 */
function extractPathFromArgs(toolName: string, args: Record<string, unknown>): string | null {
  if (['Read', 'Write', 'Edit'].includes(toolName)) return (args.file_path as string) || null;
  if (['Grep', 'Glob'].includes(toolName)) return (args.path as string) || null;
  return null;
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

      // 2. CWD 경로 제한 — CWD 안 = 자동 허용, 밖 = 퍼미션 요청
      const toolPath = extractPathFromArgs(toolName, args);
      const isOutsideCwd = toolPath ? !pathInCwd(toolPath, this.cwd) : false;

      // 3. 퍼미션 판단: 읽기 전용 도구는 CWD 안이면 무조건 허용
      const readOnlyTools = ['Read', 'Grep', 'Glob'];
      const isReadOnly = readOnlyTools.includes(toolName);
      const needsPermission = isReadOnly
        ? isOutsideCwd                         // 읽기 도구: CWD 밖이면 퍼미션
        : (isOutsideCwd || !isReadOnly);       // 쓰기 도구: 항상 퍼미션 (YOLO 제외)

      // 4. YOLO 체크 또는 퍼미션 요청
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
