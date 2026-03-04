import * as pty from 'node-pty';
import { mkdir, writeFile, readFile, unlink, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

const log = logger.child({ component: 'background-claude' });

const JOBS_DIR = join(homedir(), '.sleep-code', 'memory', 'jobs');

// ── Types ────────────────────────────────────────────────────

export interface BatchMessage {
  speaker: string;
  content: string;
  timestamp: string;
}

export interface DistillBatchResult {
  memories: Array<{
    distilled: string;
    kind: string;
    priority: number;
    topicKey: string;
    speaker: string;
    sourceIndex: number;
  }>;
}

// ── Runner ───────────────────────────────────────────────────

const DISTILL_PROMPT = `Read the file at {inputPath} — it contains a JSON array of conversation messages.

For each message, decide if it's worth remembering long-term. Consider the conversation context.

Rules:
- Decisions, preferences, facts, technical choices, feedback = REMEMBER
- Casual chat, greetings, simple acknowledgments without decision context = SKIP
- Keep the original language (Korean/English) in distilled text
- distilled: 1-2 sentences, max 200 chars, capturing the essence
- kind: fact | task | observation | proposal | feedback | decision | dialog_summary
- priority: 0-10 (10 = critical decision, 0 = trivial)
- topicKey: short English tag (e.g., "vector-db", "api-cost")

Write ONLY a JSON file to {outputPath} with this exact format:
{
  "memories": [
    {
      "distilled": "summary text",
      "kind": "decision",
      "priority": 8,
      "topicKey": "vector-db",
      "speaker": "user",
      "sourceIndex": 0
    }
  ]
}

Only include messages worth remembering. If nothing is worth remembering, write: {"memories": []}
Do not output anything else. Just write the file and exit.`;

export class BackgroundClaudeRunner {
  private isRunning = false;
  private timeoutMs: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 120_000;
  }

  get busy(): boolean {
    return this.isRunning;
  }

  async runDistill(
    messages: BatchMessage[],
    cwd?: string
  ): Promise<DistillBatchResult> {
    if (this.isRunning) {
      throw new Error('BackgroundClaudeRunner already running');
    }
    this.isRunning = true;

    const jobId = randomUUID().slice(0, 8);
    const jobDir = join(JOBS_DIR, jobId);

    try {
      await mkdir(jobDir, { recursive: true });

      const inputPath = join(jobDir, 'input.json');
      const outputPath = join(jobDir, 'output.json');

      // Write input
      await writeFile(inputPath, JSON.stringify(messages, null, 2));
      log.info({ jobId, messageCount: messages.length }, 'Starting distill batch');

      // Write prompt file (avoids multi-line PTY input issues)
      const promptPath = join(jobDir, 'prompt.md');
      const promptContent = DISTILL_PROMPT
        .replace('{inputPath}', inputPath)
        .replace('{outputPath}', outputPath);
      await writeFile(promptPath, promptContent);

      // Run Claude session
      await this.spawnAndRun(promptPath, cwd ?? homedir(), outputPath);

      // Read output
      try {
        const raw = await readFile(outputPath, 'utf-8');
        const result = JSON.parse(raw) as DistillBatchResult;
        log.info(
          { jobId, memoriesCount: result.memories.length },
          'Distill batch complete'
        );
        return result;
      } catch (err) {
        log.warn({ jobId, err }, 'Failed to read distill output');
        return { memories: [] };
      }
    } finally {
      this.isRunning = false;
      // Cleanup job files
      this.cleanup(jobDir).catch(() => {});
    }
  }

  private async spawnAndRun(promptPath: string, cwd: string, outputPath: string): Promise<void> {
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;

    const ptyProcess = pty.spawn('claude', [
      '--dangerously-skip-permissions',
      '--model', 'haiku',
    ], {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd,
      env,
    });

    let ptyOutput = '';
    ptyProcess.onData((data: string) => {
      ptyOutput += data;
    });

    try {
      // 1. Dismiss startup dialogs (trust, CLAUDE.md, etc.) until input prompt appears
      log.info('Handling startup dialogs...');
      const maxStartupMs = 30_000;
      const startupStart = Date.now();
      let lastEnterAt = 0;

      while (Date.now() - startupStart < maxStartupMs) {
        // Input prompt ready?
        if (ptyOutput.includes('Vim')) {
          log.info('Input prompt detected');
          break;
        }

        // Press Enter on any confirmation dialog (throttled to every 2s)
        if (ptyOutput.includes('confirm') && Date.now() - lastEnterAt > 2_000) {
          log.info('Confirm dialog detected, pressing Enter');
          ptyProcess.write('\r');
          lastEnterAt = Date.now();
        }

        await this.delay(500);
      }

      if (!ptyOutput.includes('Vim')) {
        log.warn({ ptyOutputTail: ptyOutput.slice(-500) }, 'Input prompt not detected after 30s');
        throw new Error('Claude input prompt not detected');
      }

      // 2. Small delay to ensure input field is focused, then send command
      await this.delay(500);
      const command = `Read the file at ${promptPath} and follow all instructions in it exactly.`;
      log.info('Sending command to Claude session');
      ptyProcess.write(command + '\r');

      // 4. Poll for output file existence
      const pollIntervalMs = 3_000;
      const startTime = Date.now();

      while (Date.now() - startTime < this.timeoutMs) {
        await this.delay(pollIntervalMs);

        if (await this.fileExists(outputPath)) {
          await this.delay(2_000);
          log.info('Output file detected, closing session');
          ptyProcess.write('/exit\r');
          await this.delay(2_000);
          return;
        }
      }

      log.warn({ ptyOutputTail: ptyOutput.slice(-500) }, 'Claude session timed out waiting for output file');
      ptyProcess.kill();
      throw new Error('Session timed out');
    } catch (err) {
      ptyProcess.kill();
      throw err;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

private async fileExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async cleanup(jobDir: string): Promise<void> {
    try {
      const inputPath = join(jobDir, 'input.json');
      const outputPath = join(jobDir, 'output.json');
      const promptPath = join(jobDir, 'prompt.md');
      await unlink(inputPath).catch(() => {});
      await unlink(outputPath).catch(() => {});
      await unlink(promptPath).catch(() => {});
      // rmdir only works on empty dirs
      const { rmdir } = await import('fs/promises');
      await rmdir(jobDir).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }
  }
}
