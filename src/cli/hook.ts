/**
 * Hook handler for Claude Code PermissionRequest events
 * This script is called by Claude Code when a permission prompt appears.
 * It forwards the request to the sleep-code daemon and waits for a decision.
 */

import { createConnection } from 'net';
import { randomUUID } from 'crypto';

const DAEMON_SOCKET = '/tmp/sleep-code-daemon.sock';
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface HookInput {
  session_id: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: any;
  cwd?: string;
}

interface PermissionDecision {
  hookSpecificOutput: {
    hookEventName: string;
    decision: {
      behavior: 'allow' | 'deny';
      message?: string;
    };
  };
}

export async function handlePermissionHook(): Promise<void> {
  // Read hook input from stdin
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookInput: HookInput;
  try {
    hookInput = JSON.parse(input);
  } catch {
    console.error('Failed to parse hook input');
    process.exit(2);
  }

  // Only handle PermissionRequest events
  if (hookInput.hook_event_name !== 'PermissionRequest') {
    // Not a permission request, exit silently
    process.exit(0);
  }

  const requestId = randomUUID().slice(0, 8);

  try {
    const decision = await forwardToDiscord(requestId, hookInput);

    const output: PermissionDecision = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision,
      },
    };

    console.log(JSON.stringify(output));
    process.exit(0);
  } catch (err) {
    console.error('Hook error:', err);
    // On error, default to deny
    const output: PermissionDecision = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: {
          behavior: 'deny',
          message: 'Hook error',
        },
      },
    };
    console.log(JSON.stringify(output));
    process.exit(0);
  }
}

function forwardToDiscord(
  requestId: string,
  hookInput: HookInput
): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
  return new Promise((resolve) => {
    const socket = createConnection(DAEMON_SOCKET);
    let messageBuffer = '';

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ behavior: 'deny', message: 'Timeout waiting for response' });
    }, TIMEOUT_MS);

    socket.on('connect', () => {
      // Send permission request to daemon
      socket.write(
        JSON.stringify({
          type: 'permission_request',
          requestId,
          sessionId: hookInput.session_id,
          toolName: hookInput.tool_name || 'Unknown',
          toolInput: hookInput.tool_input || {},
        }) + '\n'
      );
    });

    socket.on('data', (data) => {
      messageBuffer += data.toString();
      const lines = messageBuffer.split('\n');
      messageBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'permission_response' && msg.requestId === requestId) {
            clearTimeout(timeout);
            socket.end();
            resolve(msg.decision);
          }
        } catch {}
      }
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      // Daemon not running - default to deny
      resolve({ behavior: 'deny', message: 'Sleep-code daemon not running' });
    });

    socket.on('close', () => {
      clearTimeout(timeout);
    });
  });
}
