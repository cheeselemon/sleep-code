/**
 * Session manager for Slack/Discord bot - handles JSONL watching and Unix socket communication
 *
 * Simple approach: Each Claude Code session has its own JSONL file.
 * Filename = Session ID (e.g., abc123.jsonl for session abc123)
 * So we just watch each session's specific file directly.
 */

import { readFile, stat, unlink } from 'fs/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import { createServer, type Server, type Socket } from 'net';
import { createHash } from 'crypto';
import type { TodoItem } from '../types.js';
import { sessionLogger as log } from '../utils/logger.js';

const DAEMON_SOCKET = '/tmp/sleep-code-daemon.sock';
const MAX_SEEN_MESSAGES = 10000; // Prevent memory leak

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  projectDir: string;
  status: 'running' | 'idle' | 'ended';
  startedAt: Date;
  pid: number;
}

interface InternalSession extends Omit<SessionInfo, 'pid'> {
  socket: Socket;
  watcher?: FSWatcher;
  pollInterval?: NodeJS.Timeout;
  jsonlPath: string;
  seenMessages: Set<string>;
  seenMessagesOrder: string[];    // Track insertion order for LRU cleanup
  slugFound: boolean;
  lastTodosHash: string;
  inPlanMode: boolean;
  lastProcessedSize: number;      // Track last read position
  processing: boolean;            // Prevent concurrent processing
  pid: number;                    // Process ID
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: any;
}

export interface ToolResultInfo {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface PermissionRequestInfo {
  requestId: string;
  toolName: string;
  toolInput: any;
  sessionId: string;
}

export interface SessionEvents {
  onSessionStart: (session: SessionInfo) => void | Promise<void>;
  onSessionEnd: (sessionId: string) => void;
  onSessionUpdate: (sessionId: string, name: string) => void;
  onSessionStatus: (sessionId: string, status: 'running' | 'idle' | 'ended') => void;
  onMessage: (sessionId: string, role: 'user' | 'assistant', content: string) => void;
  onTodos: (sessionId: string, todos: TodoItem[]) => void;
  onToolCall: (sessionId: string, tool: ToolCallInfo) => void;
  onToolResult: (sessionId: string, result: ToolResultInfo) => void;
  onPlanModeChange: (sessionId: string, inPlanMode: boolean) => void;
  onPermissionRequest?: (request: PermissionRequestInfo) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;
  onTitleChange?: (sessionId: string, title: string) => void;
}

function hash(data: string): string {
  return createHash('md5').update(data).digest('hex');
}

export class SessionManager {
  private sessions = new Map<string, InternalSession>();
  private pendingPermissions = new Map<string, Socket>();
  private pendingAskUserQuestions = new Map<string, string>(); // sessionId -> requestId
  private events: SessionEvents;
  private server: Server | null = null;

  constructor(events: SessionEvents) {
    this.events = events;
  }

  async start(): Promise<void> {
    try {
      await unlink(DAEMON_SOCKET);
    } catch {}

    this.server = createServer((socket) => {
      let messageBuffer = '';

      socket.on('data', (data) => {
        messageBuffer += data.toString();
        const lines = messageBuffer.split('\n');
        messageBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            this.handleSessionMessage(socket, parsed);
          } catch (error) {
            log.error({ err: error }, 'Error parsing message');
          }
        }
      });

      socket.on('error', (error) => {
        log.error({ err: error }, 'Socket error');
      });

      socket.on('close', () => {
        for (const [id, session] of this.sessions) {
          if (session.socket === socket) {
            log.info({ sessionId: id }, 'Session disconnected');
            this.stopWatching(session);
            this.sessions.delete(id);
            this.events.onSessionEnd(id);
            break;
          }
        }
      });
    });

    this.server.listen(DAEMON_SOCKET, () => {
      log.info({ socket: DAEMON_SOCKET }, 'Listening');
    });
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      this.stopWatching(session);
    }
    this.sessions.clear();
    if (this.server) {
      this.server.close();
    }
  }

  sendInput(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.error({ sessionId }, 'Session not found');
      return false;
    }

    try {
      session.socket.write(JSON.stringify({ type: 'input', text }) + '\n');
    } catch (err) {
      log.error({ sessionId, err }, 'Failed to send input');
      this.stopWatching(session);
      this.sessions.delete(sessionId);
      this.events.onSessionEnd(sessionId);
      return false;
    }

    setTimeout(() => {
      try {
        session.socket.write(JSON.stringify({ type: 'input', text: '\r' }) + '\n');
      } catch {}
    }, 100);

    return true;
  }

  getSession(sessionId: string): SessionInfo | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return {
      id: session.id,
      name: session.name,
      cwd: session.cwd,
      projectDir: session.projectDir,
      status: session.status,
      startedAt: session.startedAt,
      pid: session.pid,
    };
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      projectDir: s.projectDir,
      status: s.status,
      startedAt: s.startedAt,
      pid: s.pid,
    }));
  }

  private async handleSessionMessage(socket: Socket, message: any): Promise<void> {
    switch (message.type) {
      case 'session_start': {
        // jsonlFile is always provided via --session-id flag
        const jsonlPath = `${message.projectDir}/${message.jsonlFile}`;

        let lastProcessedSize = 0;
        try {
          const fileStat = await stat(jsonlPath);
          lastProcessedSize = fileStat.size;
          log.info({ size: lastProcessedSize }, 'Existing JSONL found');
        } catch {
          log.info('JSONL file not found yet (will be created by Claude)');
        }

        const session: InternalSession = {
          id: message.id,
          name: message.name || message.command?.join(' ') || 'Session',
          cwd: message.cwd,
          projectDir: message.projectDir,
          socket,
          status: 'running',
          seenMessages: new Set(),
          seenMessagesOrder: [],
          startedAt: new Date(),
          slugFound: false,
          lastTodosHash: '',
          inPlanMode: false,
          jsonlPath,
          lastProcessedSize,
          processing: false,
          pid: message.pid || 0,
        };

        this.sessions.set(message.id, session);
        log.info({ sessionId: message.id }, 'Session started');
        log.info({ path: jsonlPath }, 'Watching JSONL');

        await this.events.onSessionStart({
          id: session.id,
          name: session.name,
          cwd: session.cwd,
          projectDir: session.projectDir,
          status: session.status,
          startedAt: session.startedAt,
          pid: session.pid,
        });

        this.startWatching(session);
        break;
      }

      case 'session_end': {
        const session = this.sessions.get(message.sessionId);
        if (session) {
          log.info({ sessionId: message.sessionId }, 'Session ended');
          this.stopWatching(session);
          this.sessions.delete(message.sessionId);
          this.events.onSessionEnd(message.sessionId);
        }
        break;
      }

      case 'title_update': {
        const session = this.sessions.get(message.sessionId);
        if (session && message.title) {
          log.info({ sessionId: message.sessionId, title: message.title }, 'Title update');
          if (this.events.onTitleChange) {
            this.events.onTitleChange(message.sessionId, message.title);
          }
        }
        break;
      }

      case 'pty_output': {
        const session = this.sessions.get(message.sessionId);
        if (session && message.content) {
          // PTY output을 backup source로 사용 - JSONL에서 못 잡은 메시지 보완
          const content = message.content.trim();
          if (content) {
            // 중복 방지: content hash로 최근 전송된 메시지와 비교
            const contentHash = hash(content.slice(0, 100)); // 앞 100자로 hash
            const recentKey = `pty:${session.id}:${contentHash}`;

            if (!session.seenMessages.has(recentKey)) {
              this.addSeenMessage(session, recentKey);
              log.info({ sessionId: session.id, preview: content.slice(0, 50), source: 'pty' }, 'Forwarding PTY message');
              this.events.onMessage(session.id, 'assistant', content);
            } else {
              log.debug({ sessionId: session.id, preview: content.slice(0, 30) }, 'Skipping duplicate PTY message');
            }
          }
        }
        break;
      }

      case 'permission_request': {
        log.info({ requestId: message.requestId, tool: message.toolName }, 'Permission request');
        this.pendingPermissions.set(message.requestId, socket);

        // AskUserQuestion: store mapping so we can allow when user answers via Discord UI
        if (message.toolName === 'AskUserQuestion') {
          log.info({ requestId: message.requestId }, 'Pending AskUserQuestion permission');
          this.pendingAskUserQuestions.set(message.sessionId, message.requestId);
          break;
        }

        if (this.events.onPermissionRequest) {
          try {
            const decision = await this.events.onPermissionRequest({
              requestId: message.requestId,
              toolName: message.toolName,
              toolInput: message.toolInput,
              sessionId: message.sessionId,
            });
            this.sendPermissionDecision(message.requestId, decision);
          } catch (err) {
            log.error({ err }, 'Error handling permission request');
            this.sendPermissionDecision(message.requestId, { behavior: 'deny', message: 'Error processing request' });
          }
        } else {
          this.sendPermissionDecision(message.requestId, { behavior: 'deny', message: 'No handler available' });
        }
        break;
      }
    }
  }

  sendPermissionDecision(requestId: string, decision: { behavior: 'allow' | 'deny'; message?: string }): void {
    const socket = this.pendingPermissions.get(requestId);
    if (!socket) {
      log.error({ requestId }, 'No pending permission for request');
      return;
    }

    try {
      socket.write(JSON.stringify({
        type: 'permission_response',
        requestId,
        decision,
      }) + '\n');
    } catch (err) {
      log.error({ err }, 'Failed to send permission decision');
    }

    this.pendingPermissions.delete(requestId);
  }

  // Allow pending AskUserQuestion permission for a session (called when user answers via Discord UI)
  allowPendingAskUserQuestion(sessionId: string, answers: Record<string, string>): void {
    const requestId = this.pendingAskUserQuestions.get(sessionId);
    if (requestId) {
      log.info({ requestId, answers }, 'Allowing AskUserQuestion permission');
      this.sendAskUserQuestionResponse(requestId, answers);
      this.pendingAskUserQuestions.delete(sessionId);
    }
  }

  private sendAskUserQuestionResponse(requestId: string, answers: Record<string, string>): void {
    const socket = this.pendingPermissions.get(requestId);
    if (!socket) {
      log.error({ requestId }, 'No pending permission for request');
      return;
    }

    try {
      socket.write(JSON.stringify({
        type: 'permission_response',
        requestId,
        decision: {
          behavior: 'allow',
          updatedInput: { answers },
        },
      }) + '\n');
    } catch (err) {
      log.error({ err }, 'Failed to send AskUserQuestion response');
    }

    this.pendingPermissions.delete(requestId);
  }

  /**
   * Add hash to seen messages with LRU cleanup
   */
  private addSeenMessage(session: InternalSession, lineHash: string): void {
    if (session.seenMessages.has(lineHash)) return;

    session.seenMessages.add(lineHash);
    session.seenMessagesOrder.push(lineHash);

    // LRU cleanup: remove oldest entries if over limit
    while (session.seenMessagesOrder.length > MAX_SEEN_MESSAGES) {
      const oldest = session.seenMessagesOrder.shift();
      if (oldest) {
        session.seenMessages.delete(oldest);
      }
    }
  }

  /**
   * Process this session's JSONL file
   */
  private async processJsonl(session: InternalSession): Promise<void> {
    // No JSONL path yet
    if (!session.jsonlPath) return;

    // Prevent concurrent processing
    if (session.processing) return;
    session.processing = true;

    try {
      const buffer = await readFile(session.jsonlPath);

      // No new content
      if (buffer.length <= session.lastProcessedSize) {
        return;
      }

      // Only read new content
      const newBuffer = buffer.subarray(session.lastProcessedSize);
      const content = newBuffer.toString('utf-8');

      // Split by newline, keeping track of incomplete last line
      const parts = content.split('\n');
      const lastPart = parts.pop() || '';

      // If last part is not empty, it's an incomplete line - don't process it yet
      const incompleteBytes = Buffer.byteLength(lastPart, 'utf-8');
      session.lastProcessedSize = buffer.length - incompleteBytes;

      const lines = parts.filter(Boolean);
      log.debug({ lines: lines.length, buffered: incompleteBytes }, 'Processing new lines');

      for (const line of lines) {
        const lineHash = hash(line);
        if (session.seenMessages.has(lineHash)) {
          log.trace('Skipping duplicate line');
          continue;
        }
        this.addSeenMessage(session, lineHash);

        // Parse once, reuse result
        let data: any;
        try {
          data = JSON.parse(line);
          log.trace({ type: data.type, role: data.message?.role, isMeta: data.isMeta, subtype: data.subtype }, 'Parsed line');
        } catch {
          continue;
        }

        // Extract session name (slug)
        if (!session.slugFound && data.slug && typeof data.slug === 'string') {
          session.slugFound = true;
          session.name = data.slug;
          log.info({ sessionId: session.id, name: data.slug }, 'Session name');
          this.events.onSessionUpdate(session.id, data.slug);
        }

        // Extract todos
        if (data.todos && Array.isArray(data.todos) && data.todos.length > 0) {
          const todos: TodoItem[] = data.todos.map((t: any) => ({
            content: t.content || '',
            status: t.status || 'pending',
            activeForm: t.activeForm,
          }));
          const todosHash = hash(JSON.stringify(todos));
          if (todosHash !== session.lastTodosHash) {
            session.lastTodosHash = todosHash;
            this.events.onTodos(session.id, todos);
          }
        }

        // Detect plan mode changes
        if (data.type === 'user') {
          const msgContent = data.message?.content;
          if (typeof msgContent === 'string') {
            if (msgContent.includes('<system-reminder>') && msgContent.includes('Plan mode is active')) {
              if (!session.inPlanMode) {
                session.inPlanMode = true;
                log.info({ sessionId: session.id, planMode: true }, 'Plan mode changed');
                this.events.onPlanModeChange(session.id, true);
              }
            } else if (msgContent.includes('Exited Plan Mode') || msgContent.includes('exited plan mode')) {
              if (session.inPlanMode) {
                session.inPlanMode = false;
                log.info({ sessionId: session.id, planMode: false }, 'Plan mode changed');
                this.events.onPlanModeChange(session.id, false);
              }
            }
          }
        }

        // Extract tool calls from assistant messages
        if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
          for (const block of data.message.content) {
            if (block.type === 'tool_use' && block.id && block.name) {
              log.debug({ tool: block.name }, 'Tool call');
              this.events.onToolCall(session.id, {
                id: block.id,
                name: block.name,
                input: block.input || {},
              });
            }
          }
        }

        // Extract tool results from user messages
        if (data.type === 'user' && Array.isArray(data.message?.content)) {
          for (const block of data.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              let text = '';
              if (typeof block.content === 'string') {
                text = block.content;
              } else if (Array.isArray(block.content)) {
                text = block.content
                  .filter((b: any) => b.type === 'text')
                  .map((b: any) => b.text)
                  .join('\n');
              }
              this.events.onToolResult(session.id, {
                toolUseId: block.tool_use_id,
                content: text,
                isError: block.is_error === true,
              });
            }
          }
        }

        // Parse and forward chat messages
        if ((data.type === 'user' || data.type === 'assistant') && !data.isMeta && !data.subtype) {
          const message = data.message;
          if (message?.role) {
            let textContent = '';
            if (typeof message.content === 'string') {
              textContent = message.content;
            } else if (Array.isArray(message.content)) {
              for (const block of message.content) {
                if (block.type === 'text' && block.text) {
                  textContent += block.text;
                }
              }
            }

            if (textContent.trim()) {
              const messageTime = new Date(data.timestamp || Date.now());
              if (messageTime >= session.startedAt) {
                // 중복 방지: content hash로 PTY에서 이미 보낸 메시지인지 확인
                const trimmedContent = textContent.trim();
                const contentHash = hash(trimmedContent.slice(0, 100));
                const contentKey = `pty:${session.id}:${contentHash}`;

                if (session.seenMessages.has(contentKey)) {
                  log.debug({ role: message.role, preview: trimmedContent.slice(0, 30) }, 'Skipping (already sent via PTY)');
                } else {
                  // JSONL 소스로 마킹하여 PTY에서 중복 전송 방지
                  this.addSeenMessage(session, contentKey);
                  log.info({ role: message.role, preview: trimmedContent.slice(0, 50), source: 'jsonl' }, 'Forwarding message');
                  this.events.onMessage(session.id, message.role, trimmedContent);
                }

                // Update status based on message role
                // user message → Claude starts thinking → typing indicator ON
                // assistant message → Claude is responding → typing indicator OFF
                if (message.role === 'user' && session.status !== 'running') {
                  session.status = 'running';
                  this.events.onSessionStatus(session.id, 'running');
                } else if (message.role === 'assistant' && session.status !== 'idle') {
                  session.status = 'idle';
                  this.events.onSessionStatus(session.id, 'idle');
                }
              } else {
                log.debug('Skipping old message (before session start)');
              }
            } else {
              log.trace({ role: message.role }, 'Message has no text content');
            }
          }
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        log.error({ err }, 'Error processing JSONL');
      }
    } finally {
      session.processing = false;
    }
  }

  private startWatching(session: InternalSession): void {
    if (!session.jsonlPath) return;

    try {
      session.watcher = chokidar.watch(session.jsonlPath, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 100,  // 100ms 동안 변화 없으면 완료로 간주
          pollInterval: 50,
        },
      });

      session.watcher.on('change', async () => {
        await this.processJsonl(session);
      });

      session.watcher.on('add', async () => {
        // 파일이 새로 생성된 경우
        await this.processJsonl(session);
      });

      session.watcher.on('error', (err) => {
        log.error({ err }, 'Chokidar watcher error');
      });
    } catch (err) {
      log.error({ err }, 'Error setting up chokidar watcher');
    }

    // Poll as backup (chokidar가 놓칠 수 있는 경우 대비)
    session.pollInterval = setInterval(async () => {
      if (!this.sessions.has(session.id)) {
        if (session.pollInterval) clearInterval(session.pollInterval);
        return;
      }
      await this.processJsonl(session);
    }, 2000);

    // Initial process
    this.processJsonl(session);
    log.info({ path: session.jsonlPath }, 'Now watching with chokidar');
  }

  private stopWatching(session: InternalSession): void {
    if (session.watcher) {
      session.watcher.close();
    }
    if (session.pollInterval) {
      clearInterval(session.pollInterval);
    }
  }
}
