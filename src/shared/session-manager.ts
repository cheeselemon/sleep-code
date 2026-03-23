/**
 * Session manager for Slack/Discord bot - handles JSONL watching and Unix socket communication
 *
 * Simple approach: Each Claude Code session has its own JSONL file.
 * Filename = Session ID (e.g., abc123.jsonl for session abc123)
 * So we just watch each session's specific file directly.
 */

import { open, stat, unlink } from 'fs/promises';
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
    // Clean up stale socket, verify no other process is listening
    try {
      await unlink(DAEMON_SOCKET);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        log.warn({ err }, 'Failed to unlink daemon socket');
      }
    }

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
            this.handleSessionMessage(socket, parsed).catch((err) => {
              log.error({ err }, 'Unhandled error in handleSessionMessage');
            });
          } catch (error) {
            log.error({ err: error }, 'Error parsing message');
          }
        }
      });

      socket.on('error', (error) => {
        log.error({ err: error }, 'Socket error');
      });

      socket.on('close', () => {
        // Clean up ALL sessions on this socket + their pending permissions
        const closedSessionIds: string[] = [];
        for (const [id, session] of this.sessions) {
          if (session.socket === socket) {
            closedSessionIds.push(id);
          }
        }

        for (const id of closedSessionIds) {
          const session = this.sessions.get(id)!;
          log.info({ sessionId: id }, 'Session disconnected');
          this.stopWatching(session);
          this.sessions.delete(id);
          this.cleanupPendingForSession(id, socket);
          this.events.onSessionEnd(id);
        }
      });
    });

    this.server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        log.error({ socket: DAEMON_SOCKET }, 'Daemon socket already in use by another process');
      } else {
        log.error({ err }, 'Server error');
      }
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
    this.pendingPermissions.clear();
    this.pendingAskUserQuestions.clear();
    if (this.server) {
      this.server.close();
    }
  }

  sendInput(sessionId: string, text: string, submit = true): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      log.error({ sessionId }, 'Session not found');
      return false;
    }

    if (session.socket.destroyed || !session.socket.writable) {
      log.error({ sessionId }, 'Socket not writable');
      this.stopWatching(session);
      this.sessions.delete(sessionId);
      this.events.onSessionEnd(sessionId);
      return false;
    }

    try {
      session.socket.write(JSON.stringify({ type: 'input', text, submit }) + '\n');
    } catch (err) {
      log.error({ sessionId, err }, 'Failed to send input');
      this.stopWatching(session);
      this.sessions.delete(sessionId);
      this.events.onSessionEnd(sessionId);
      return false;
    }

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
          // Use PTY output as backup source - supplement messages missed by JSONL
          const content = message.content.trim();
          if (content) {
            // Dedup: compare with recently sent messages using content hash
            const contentHash = hash(content.slice(0, 100)); // hash first 100 chars
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
        // Only handle permissions for sessions tracked by sleep-code
        if (!this.sessions.has(message.sessionId)) {
          log.info({ sessionId: message.sessionId, tool: message.toolName }, 'Permission request from untracked session, passing through');
          socket.write(JSON.stringify({ type: 'permission_passthrough', requestId: message.requestId }) + '\n');
          break;
        }

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
   * Clean up pending permissions and AskUserQuestion entries for a closed session/socket
   */
  private cleanupPendingForSession(sessionId: string, socket: Socket): void {
    // Clean up pendingPermissions entries that belong to this socket
    for (const [requestId, pendingSocket] of this.pendingPermissions) {
      if (pendingSocket === socket) {
        this.pendingPermissions.delete(requestId);
        log.debug({ requestId, sessionId }, 'Cleaned orphan pending permission');
      }
    }

    // Clean up pendingAskUserQuestions for this session
    this.pendingAskUserQuestions.delete(sessionId);
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
   * Process this session's JSONL file (incremental read via file descriptor)
   */
  private async processJsonl(session: InternalSession): Promise<void> {
    // No JSONL path yet
    if (!session.jsonlPath) return;

    // Prevent concurrent processing
    if (session.processing) return;
    session.processing = true;

    try {
      const fileStat = await stat(session.jsonlPath);

      // Detect file truncation/rotation: size shrunk → reset position
      if (fileStat.size < session.lastProcessedSize) {
        log.warn({ sessionId: session.id, prevSize: session.lastProcessedSize, newSize: fileStat.size }, 'JSONL file truncated/rotated, resetting position');
        session.lastProcessedSize = 0;
      }

      // No new content
      if (fileStat.size <= session.lastProcessedSize) {
        return;
      }

      // Read only new bytes via file descriptor (avoids loading entire file)
      const bytesToRead = fileStat.size - session.lastProcessedSize;
      const fd = await open(session.jsonlPath, 'r');
      let content: string;
      try {
        const buf = Buffer.alloc(bytesToRead);
        await fd.read(buf, 0, bytesToRead, session.lastProcessedSize);
        content = buf.toString('utf-8');
      } finally {
        await fd.close();
      }

      // Split by newline, keeping track of incomplete last line
      const parts = content.split('\n');
      const lastPart = parts.pop() || '';

      // If last part is not empty, it's an incomplete line - don't process it yet
      const incompleteBytes = Buffer.byteLength(lastPart, 'utf-8');
      session.lastProcessedSize = fileStat.size - incompleteBytes;

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

            // Skip local command output (e.g. /compact summary, /changelog)
            // These are internal CLI outputs wrapped in <local-command-stdout> tags
            if (textContent.includes('<local-command-stdout>')) {
              log.debug({ preview: textContent.slice(0, 50) }, 'Skipping local command stdout');
              continue;
            }

            if (textContent.trim()) {
              const messageTime = new Date(data.timestamp || Date.now());
              if (messageTime >= session.startedAt) {
                // Dedup: check if message was already sent via PTY using content hash
                const trimmedContent = textContent.trim();
                const contentHash = hash(trimmedContent.slice(0, 100));
                const contentKey = `pty:${session.id}:${contentHash}`;

                if (session.seenMessages.has(contentKey)) {
                  log.debug({ role: message.role, preview: trimmedContent.slice(0, 30) }, 'Skipping (already sent via PTY)');
                } else {
                  // Mark as JSONL source to prevent duplicate sends from PTY
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
          stabilityThreshold: 100,  // Consider complete if no changes for 100ms
          pollInterval: 50,
        },
      });

      session.watcher.on('change', async () => {
        await this.processJsonl(session);
      });

      session.watcher.on('add', async () => {
        // When file is newly created
        await this.processJsonl(session);
      });

      session.watcher.on('error', (err) => {
        log.error({ err }, 'Chokidar watcher error');
      });
    } catch (err) {
      log.error({ err }, 'Error setting up chokidar watcher');
    }

    // Poll as backup (in case chokidar misses events)
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
