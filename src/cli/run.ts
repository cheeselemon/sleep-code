import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { createConnection, type Socket } from 'net';
import * as pty from 'node-pty';
// import { PtyOutputParser } from '../shared/pty-output-parser.js';

const DAEMON_SOCKET = '/tmp/sleep-code-daemon.sock';
const RECONNECT_INTERVAL = 2000;
const MAX_RECONNECT_INTERVAL = 30000;

function getClaudeProjectDir(cwd: string): string {
  const encodedPath = cwd.replace(/\//g, '-');
  return `${homedir()}/.claude/projects/${encodedPath}`;
}

interface DaemonConnectionConfig {
  sessionId: string;
  projectDir: string;
  cwd: string;
  command: string[];
  jsonlFile: string;
  pid: number;
  onInput: (text: string) => void;
}

class DaemonConnection {
  private config: DaemonConnectionConfig;
  private socket: Socket | null = null;
  private messageBuffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectInterval = RECONNECT_INTERVAL;
  private closed = false;
  private connected = false;

  constructor(config: DaemonConnectionConfig) {
    this.config = config;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;

    this.socket = createConnection(DAEMON_SOCKET);
    this.messageBuffer = '';

    this.socket.on('connect', () => {
      this.connected = true;
      this.reconnectInterval = RECONNECT_INTERVAL;
      console.error('[sleep-code] Connected to relay');

      // Tell daemon about this session (jsonlFile is always known via --session-id)
      this.socket!.write(JSON.stringify({
        type: 'session_start',
        id: this.config.sessionId,
        projectDir: this.config.projectDir,
        cwd: this.config.cwd,
        command: this.config.command,
        name: this.config.command.join(' '),
        jsonlFile: this.config.jsonlFile,
        pid: this.config.pid,
      }) + '\n');
    });

    this.socket.on('data', (data) => {
      this.messageBuffer += data.toString();

      const lines = this.messageBuffer.split('\n');
      this.messageBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'input' && msg.text) {
            this.config.onInput(msg.text);
          }
        } catch {}
      }
    });

    this.socket.on('error', () => {});

    this.socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;

      if (this.closed) return;

      if (wasConnected) {
        console.error('[sleep-code] Disconnected from relay, reconnecting...');
      }

      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectInterval);

    this.reconnectInterval = Math.min(this.reconnectInterval * 1.5, MAX_RECONNECT_INTERVAL);
  }

  sendTitle(title: string): void {
    if (this.connected && this.socket) {
      try {
        this.socket.write(JSON.stringify({
          type: 'title_update',
          sessionId: this.config.sessionId,
          title,
        }) + '\n');
      } catch {}
    }
  }

  sendPtyOutput(content: string, isThinking: boolean): void {
    if (this.connected && this.socket && content) {
      try {
        this.socket.write(JSON.stringify({
          type: 'pty_output',
          sessionId: this.config.sessionId,
          content,
          isThinking,
          timestamp: Date.now(),
        }) + '\n');
      } catch {}
    }
  }

  close(): void {
    this.closed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket && this.connected) {
      try {
        this.socket.write(JSON.stringify({
          type: 'session_end',
          sessionId: this.config.sessionId
        }) + '\n');
        this.socket.end();
      } catch {}
    }

    this.socket = null;
  }
}

// Braille spinner characters used by Claude Code
const SPINNER_CHARS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐⠂⠄⠠⠈⠁✓✗✳●○◐◑◒◓]\s*/;

/**
 * Terminal title extractor with buffering and debouncing
 */
class TitleExtractor {
  private buffer = '';
  private lastNormalizedTitle = '';
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingTitle: string | null = null;
  private onTitleChange: ((title: string) => void) | null = null;

  constructor(onTitleChange?: (title: string) => void) {
    this.onTitleChange = onTitleChange || null;
  }

  /**
   * Normalize title by removing spinner characters
   */
  private normalizeTitle(title: string): string {
    return title.replace(SPINNER_CHARS, '').trim();
  }

  /**
   * Process PTY data and extract terminal title if present
   */
  process(data: string): void {
    // Append to buffer
    this.buffer += data;

    // Only keep last 1KB to prevent memory issues
    if (this.buffer.length > 1024) {
      this.buffer = this.buffer.slice(-1024);
    }

    // OSC (Operating System Command) for setting title: ESC ] 0 ; title BEL
    // or ESC ] 2 ; title BEL (title only, no icon)
    // BEL can be \x07 or ESC \ (\x1b\\)
    const match = this.buffer.match(/\x1b\](?:0|2);([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
    if (match) {
      const rawTitle = match[1];
      // Clear buffer after successful match
      this.buffer = '';

      if (!rawTitle) return;

      // Normalize by removing spinner
      const normalized = this.normalizeTitle(rawTitle);
      if (!normalized || normalized === this.lastNormalizedTitle) return;

      this.lastNormalizedTitle = normalized;
      this.pendingTitle = normalized;

      // Debounce: wait 500ms before sending to avoid rapid updates
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        if (this.pendingTitle && this.onTitleChange) {
          this.onTitleChange(this.pendingTitle);
        }
        this.debounceTimer = null;
      }, 500);
    }
  }
}


export async function run(command: string[], providedSessionId?: string): Promise<void> {
  // Use provided session ID or generate a new one
  const sessionId = providedSessionId || randomUUID();
  const cwd = process.cwd();
  const projectDir = getClaudeProjectDir(cwd);

  // JSONL filename is deterministic: {sessionId}.jsonl
  const jsonlFile = `${sessionId}.jsonl`;

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Inject --session-id flag to control JSONL filename
  const args = [...command.slice(1), '--session-id', sessionId];

  const ptyProcess = pty.spawn(command[0], args, {
    name: process.env.TERM || 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>,
  });

  const daemon = new DaemonConnection({
    sessionId,
    projectDir,
    cwd,
    command,
    jsonlFile,
    pid: ptyProcess.pid,
    onInput: (text) => {
      ptyProcess.write(text);
    },
  });
  daemon.start();

  console.error(`[sleep-code] Session ID: ${sessionId}`);
  console.error(`[sleep-code] JSONL file: ${projectDir}/${jsonlFile}`);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const titleExtractor = new TitleExtractor((title) => {
    daemon.sendTitle(title);
  });

  // PTY output parsing disabled - user input also appears in stdout
  // TODO: Need to filter out user input before enabling
  // const ptyOutputParser = new PtyOutputParser((output) => {
  //   daemon.sendPtyOutput(output.content, output.isThinking);
  // });

  ptyProcess.onData((data: string) => {
    process.stdout.write(data);
    titleExtractor.process(data);
    // ptyOutputParser.process(data);
  });

  const onStdinData = (data: Buffer) => {
    ptyProcess.write(data.toString());
  };
  process.stdin.on('data', onStdinData);

  process.stdout.on('resize', () => {
    ptyProcess.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  });

  await new Promise<void>((resolve) => {
    ptyProcess.onExit(() => {
      process.stdin.removeListener('data', onStdinData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      if (typeof process.stdin.unref === 'function') {
        process.stdin.unref();
      }

      daemon.close();
      resolve();
    });
  });
}
