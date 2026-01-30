/**
 * Session manager for Slack/Discord bot - handles JSONL watching and Unix socket communication
 *
 * Simple approach: Each Claude Code session has its own JSONL file.
 * Filename = Session ID (e.g., abc123.jsonl for session abc123)
 * So we just watch each session's specific file directly.
 */

import { watch, type FSWatcher } from 'fs';
import { readFile, stat, unlink } from 'fs/promises';
import { createServer, type Server, type Socket } from 'net';
import { createHash } from 'crypto';
import type { TodoItem } from '../types.js';

const DAEMON_SOCKET = '/tmp/sleep-code-daemon.sock';
const MAX_SEEN_MESSAGES = 10000; // Prevent memory leak

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  projectDir: string;
  status: 'running' | 'idle' | 'ended';
  startedAt: Date;
}

interface InternalSession extends SessionInfo {
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
            console.error('[SessionManager] Error parsing message:', error);
          }
        }
      });

      socket.on('error', (error) => {
        console.error('[SessionManager] Socket error:', error);
      });

      socket.on('close', () => {
        for (const [id, session] of this.sessions) {
          if (session.socket === socket) {
            console.log(`[SessionManager] Session disconnected: ${id}`);
            this.stopWatching(session);
            this.sessions.delete(id);
            this.events.onSessionEnd(id);
            break;
          }
        }
      });
    });

    this.server.listen(DAEMON_SOCKET, () => {
      console.log(`[SessionManager] Listening on ${DAEMON_SOCKET}`);
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
      console.error(`[SessionManager] Session not found: ${sessionId}`);
      return false;
    }

    try {
      session.socket.write(JSON.stringify({ type: 'input', text }) + '\n');
    } catch (err) {
      console.error(`[SessionManager] Failed to send input to ${sessionId}:`, err);
      this.stopWatching(session);
      this.sessions.delete(sessionId);
      this.events.onSessionEnd(sessionId);
      return false;
    }

    setTimeout(() => {
      try {
        session.socket.write(JSON.stringify({ type: 'input', text: '\r' }) + '\n');
      } catch {}
    }, 50);

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
          console.log(`[SessionManager] Existing JSONL found, size: ${lastProcessedSize} bytes`);
        } catch {
          console.log(`[SessionManager] JSONL file not found yet (will be created by Claude)`);
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
        };

        this.sessions.set(message.id, session);
        console.log(`[SessionManager] Session started: ${message.id}`);
        console.log(`[SessionManager] Watching: ${jsonlPath}`);

        await this.events.onSessionStart({
          id: session.id,
          name: session.name,
          cwd: session.cwd,
          projectDir: session.projectDir,
          status: session.status,
          startedAt: session.startedAt,
        });

        this.startWatching(session);
        break;
      }

      case 'session_end': {
        const session = this.sessions.get(message.sessionId);
        if (session) {
          console.log(`[SessionManager] Session ended: ${message.sessionId}`);
          this.stopWatching(session);
          this.sessions.delete(message.sessionId);
          this.events.onSessionEnd(message.sessionId);
        }
        break;
      }

      case 'title_update': {
        const session = this.sessions.get(message.sessionId);
        if (session && message.title) {
          console.log(`[SessionManager] Title update for ${message.sessionId}: ${message.title}`);
          if (this.events.onTitleChange) {
            this.events.onTitleChange(message.sessionId, message.title);
          }
        }
        break;
      }

      case 'permission_request': {
        console.log(`[SessionManager] Permission request: ${message.requestId} - ${message.toolName}`);
        this.pendingPermissions.set(message.requestId, socket);

        // AskUserQuestion: store mapping so we can allow when user answers via Discord UI
        if (message.toolName === 'AskUserQuestion') {
          console.log(`[SessionManager] Pending AskUserQuestion permission: ${message.requestId}`);
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
            console.error('[SessionManager] Error handling permission request:', err);
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
      console.error(`[SessionManager] No pending permission for request: ${requestId}`);
      return;
    }

    try {
      socket.write(JSON.stringify({
        type: 'permission_response',
        requestId,
        decision,
      }) + '\n');
    } catch (err) {
      console.error('[SessionManager] Failed to send permission decision:', err);
    }

    this.pendingPermissions.delete(requestId);
  }

  // Allow pending AskUserQuestion permission for a session (called when user answers via Discord UI)
  allowPendingAskUserQuestion(sessionId: string, answers: Record<string, string>): void {
    const requestId = this.pendingAskUserQuestions.get(sessionId);
    if (requestId) {
      console.log(`[SessionManager] Allowing AskUserQuestion permission: ${requestId} with answers:`, answers);
      this.sendAskUserQuestionResponse(requestId, answers);
      this.pendingAskUserQuestions.delete(sessionId);
    }
  }

  private sendAskUserQuestionResponse(requestId: string, answers: Record<string, string>): void {
    const socket = this.pendingPermissions.get(requestId);
    if (!socket) {
      console.error(`[SessionManager] No pending permission for request: ${requestId}`);
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
      console.error('[SessionManager] Failed to send AskUserQuestion response:', err);
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
      session.lastProcessedSize = buffer.length;

      const content = newBuffer.toString('utf-8');
      const lines = content.split('\n').filter(Boolean);

      for (const line of lines) {
        const lineHash = hash(line);
        if (session.seenMessages.has(lineHash)) continue;
        this.addSeenMessage(session, lineHash);

        // Parse once, reuse result
        let data: any;
        try {
          data = JSON.parse(line);
        } catch {
          continue;
        }

        // Extract session name (slug)
        if (!session.slugFound && data.slug && typeof data.slug === 'string') {
          session.slugFound = true;
          session.name = data.slug;
          console.log(`[SessionManager] Session ${session.id} name: ${data.slug}`);
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
                console.log(`[SessionManager] Session ${session.id} plan mode: true`);
                this.events.onPlanModeChange(session.id, true);
              }
            } else if (msgContent.includes('Exited Plan Mode') || msgContent.includes('exited plan mode')) {
              if (session.inPlanMode) {
                session.inPlanMode = false;
                console.log(`[SessionManager] Session ${session.id} plan mode: false`);
                this.events.onPlanModeChange(session.id, false);
              }
            }
          }
        }

        // Extract tool calls from assistant messages
        if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
          for (const block of data.message.content) {
            if (block.type === 'tool_use' && block.id && block.name) {
              console.log(`[SessionManager] Tool call: ${block.name}`);
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
                this.events.onMessage(session.id, message.role, textContent.trim());
              }
            }
          }
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        console.error(`[SessionManager] Error processing JSONL:`, err);
      }
    } finally {
      session.processing = false;
    }
  }

  private startWatching(session: InternalSession): void {
    if (!session.jsonlPath) return;

    // Extract just the filename for comparison
    const jsonlFilename = session.jsonlPath.split('/').pop();

    try {
      session.watcher = watch(session.projectDir, { recursive: false }, async (_, filename) => {
        if (filename === jsonlFilename) {
          await this.processJsonl(session);
        }
      });
    } catch (err) {
      console.error(`[SessionManager] Error setting up watcher:`, err);
    }

    // Poll as backup (every 1 second)
    session.pollInterval = setInterval(async () => {
      if (!this.sessions.has(session.id)) {
        if (session.pollInterval) clearInterval(session.pollInterval);
        return;
      }
      await this.processJsonl(session);
    }, 1000);

    // Initial process
    this.processJsonl(session);
    console.log(`[SessionManager] Now watching: ${session.jsonlPath}`);
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
