import type { ProcessManager } from './process-manager.js';
import type { SessionManager } from '../slack/session-manager.js';

export interface ClaudeTransportInputOptions {
  submit?: boolean;
}

export interface ClaudeTransport {
  type: 'pty' | 'sdk';
  sessionId: string;
  supportsTerminalControls: boolean;
  supportsModelSwitch: boolean;
  sendInput(text: string, options?: ClaudeTransportInputOptions): boolean | Promise<boolean>;
  interrupt(): boolean | Promise<boolean>;
  stop(): Promise<void>;
  isActive(): boolean;
}

export function createPtyTransport(
  sessionId: string,
  sessionManager: SessionManager,
  processManager?: ProcessManager,
): ClaudeTransport {
  return {
    type: 'pty',
    sessionId,
    supportsTerminalControls: true,
    supportsModelSwitch: true,
    sendInput(text, options) {
      return sessionManager.sendInput(sessionId, text, options?.submit ?? true);
    },
    interrupt() {
      return sessionManager.sendInput(sessionId, '\x1b\x1b', false);
    },
    async stop() {
      if (processManager) {
        await processManager.kill(sessionId);
      }
    },
    isActive() {
      return !!sessionManager.getSession(sessionId);
    },
  };
}
