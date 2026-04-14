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
      // 민감 환경변수 필터링 — exact match + wildcard 패턴
      // TOKEN, SECRET, KEY, PASSWORD, CREDENTIAL, AUTH 포함 키를 모두 차단
      const SENSITIVE_PATTERNS = /(?:^(OPENROUTER_API_KEY|DEEPINFRA_API_KEY|OPENAI_API_KEY|DISCORD_BOT_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY|GITHUB_TOKEN|NPM_TOKEN)$)|(?:_(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH)$)|(?:^(?:AWS_|GCP_|AZURE_|GOOGLE_))/i;
      const safeEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (!SENSITIVE_PATTERNS.test(key) && value !== undefined) {
          safeEnv[key] = value;
        }
      }
      safeEnv.TERM = 'dumb';

      const proc = spawn('bash', ['-lc', command], {
        cwd,
        timeout,
        env: safeEnv,
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
