import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { createConnection, type Socket } from 'net';
import * as pty from 'node-pty';

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


export async function run(command: string[]): Promise<void> {
  // Use full UUID - Claude Code requires valid UUID for --session-id
  const sessionId = randomUUID();
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

  ptyProcess.onData((data: string) => {
    process.stdout.write(data);
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
