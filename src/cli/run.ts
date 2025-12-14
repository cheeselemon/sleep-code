import { spawn } from 'bun';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

const BASE_PORT = 3284;
const DAEMON_SOCKET = '/tmp/snowfort-daemon.sock';

async function findAgentAPI(): Promise<string> {
  // Check common locations
  const candidates = [
    'agentapi', // In PATH
    join(homedir(), 'go', 'bin', 'agentapi'),
    '/usr/local/bin/agentapi',
    '/opt/homebrew/bin/agentapi',
  ];

  for (const candidate of candidates) {
    try {
      const result = await Bun.$`which ${candidate}`.quiet();
      if (result.exitCode === 0) {
        return candidate;
      }
    } catch {}

    // Also check if file exists directly
    const file = Bun.file(candidate);
    if (await file.exists()) {
      return candidate;
    }
  }

  throw new Error(
    'AgentAPI not found. Install with: go install github.com/coder/agentapi@latest'
  );
}

interface SessionInfo {
  id: string;
  port: number;
  cwd: string;
  command: string[];
}

async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (port < startPort + 100) {
    try {
      // Try to connect to see if something is listening
      const response = await fetch(`http://localhost:${port}/`, {
        signal: AbortSignal.timeout(100)
      });
      // Port is in use, try next
      port++;
    } catch {
      // Port is likely free (connection refused)
      return port;
    }
  }
  throw new Error('No available port found');
}

async function notifyDaemon(session: SessionInfo): Promise<void> {
  try {
    // Try to connect to daemon via Unix socket
    const socket = await Bun.connect({
      unix: DAEMON_SOCKET,
      socket: {
        data(socket, data) {},
        error(socket, error) {},
        close(socket) {},
      },
    });
    socket.write(JSON.stringify({ type: 'session_start', ...session }));
    socket.end();
  } catch {
    // Daemon not running, that's okay for now
  }
}

export async function run(command: string[]): Promise<void> {
  const sessionId = randomUUID();
  const port = await findAvailablePort(BASE_PORT);
  const cwd = process.cwd();
  const agentapiPath = await findAgentAPI();

  console.log(`Starting session ${sessionId.slice(0, 8)}... on port ${port}`);

  // Start AgentAPI with the command
  const agentapiArgs = [
    'server',
    '--port', port.toString(),
    '--',
    ...command,
  ];

  const agentapi = spawn({
    cmd: [agentapiPath, ...agentapiArgs],
    cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  // Give it a moment to start
  await Bun.sleep(500);

  // Check if process is still running
  if (agentapi.exitCode !== null) {
    throw new Error(`AgentAPI exited immediately with code ${agentapi.exitCode}`);
  }

  // Wait for AgentAPI to be ready
  await waitForAgentAPI(port);

  // Notify daemon about new session
  await notifyDaemon({ id: sessionId, port, cwd, command });

  console.log(`Session ready. Attaching to terminal...`);
  console.log(`(AgentAPI available at http://localhost:${port})`);
  console.log('');

  // Attach to the terminal session
  const attach = spawn({
    cmd: [agentapiPath, 'attach', '--url', `localhost:${port}`],
    cwd,
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  // Wait for attach to complete (user exits or session ends)
  await attach.exited;

  // Clean up
  agentapi.kill();
  console.log('\nSession ended.');
}

async function waitForAgentAPI(port: number, maxAttempts = 50): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/status`);
      if (response.ok) {
        return;
      }
    } catch (err) {
      // Not ready yet
    }
    await Bun.sleep(200);
  }
  throw new Error('AgentAPI failed to start');
}
