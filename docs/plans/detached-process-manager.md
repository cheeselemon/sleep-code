# Design Document: Robust Detached Process Management System

## Executive Summary

This design introduces a detached process management system that allows the Discord bot to start, stop, and manage Claude Code sessions independently, surviving bot restarts. The key insight is generating the sessionId **before** spawning the process, passing it as an argument, which enables immediate PID-to-sessionId correlation.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DISCORD BOT                                     │
│                                                                              │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────────────┐ │
│  │  discord-app.ts │    │  ProcessManager  │    │    SettingsManager      │ │
│  │                 │    │                  │    │                         │ │
│  │  Slash Commands:│◄──►│  - spawn()       │◄──►│  - allowedDirectories[] │ │
│  │  /claude start  │    │  - kill()        │    │  - addDirectory()       │ │
│  │  /claude stop   │    │  - healthCheck() │    │  - removeDirectory()    │ │
│  │  /claude add-dir│    │  - registry.json │    │  - settings.json        │ │
│  │  /claude status │    └────────┬─────────┘    └─────────────────────────┘ │
│  └────────┬────────┘             │                                           │
│           │                      │                                           │
│           ▼                      ▼                                           │
│  ┌─────────────────┐    ┌──────────────────────────────────────────────────┐│
│  │ ChannelManager  │◄──►│                SessionManager                    ││
│  │                 │    │                                                  ││
│  │ - session-      │    │  Unix Socket: /tmp/sleep-code-daemon.sock        ││
│  │   mappings.json │    │                                                  ││
│  │ - threadId ↔    │    │  - onSessionStart()                              ││
│  │   sessionId     │    │  - onSessionEnd()                                ││
│  └─────────────────┘    │  - sendInput(), permissions                      ││
│                         └─────────────────────────┬────────────────────────┘│
└───────────────────────────────────────────────────┼─────────────────────────┘
                                                    │
                              Unix Socket           │
                         ┌──────────────────────────┘
                         │
    ┌────────────────────┼────────────────────────────────────────────────────┐
    │                    ▼           DETACHED PROCESS (per session)           │
    │  ┌─────────────────────────────────────────────────────────────────────┐│
    │  │                          run.ts                                     ││
    │  │                                                                     ││
    │  │   ┌─────────────────┐        ┌────────────────────┐                 ││
    │  │   │ DaemonConnection│◄──────►│     PTY (claude)   │                 ││
    │  │   │                 │        │                    │                 ││
    │  │   │ - session_start │        │ - spawns claude    │                 ││
    │  │   │ - session_end   │        │ - handles I/O      │                 ││
    │  │   │ - auto-reconnect│        │ - title extraction │                 ││
    │  │   └─────────────────┘        └────────────────────┘                 ││
    │  └─────────────────────────────────────────────────────────────────────┘│
    └─────────────────────────────────────────────────────────────────────────┘
```

### Persistent Storage Layout

```
~/.sleep-code/
├── discord.env              # Bot credentials (existing)
├── session-mappings.json    # threadId ↔ sessionId (existing)
├── process-registry.json    # pid ↔ sessionId (NEW)
└── settings.json            # Directory whitelist (NEW)
```

---

## 2. Data Structures

### 2.1 Process Registry (`process-registry.json`)

```typescript
interface ProcessEntry {
  pid: number;                    // OS process ID
  sessionId: string;              // UUID matching Claude session
  cwd: string;                    // Working directory
  startedAt: string;              // ISO 8601 timestamp
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'orphaned';
  threadId?: string;              // Discord thread ID (populated after session_start)
  command: string[];              // Full command for debugging
  lastVerified?: string;          // Last health check timestamp
}

interface ProcessRegistry {
  version: 1;
  entries: ProcessEntry[];
}
```

**Example:**
```json
{
  "version": 1,
  "entries": [
    {
      "pid": 12345,
      "sessionId": "e62ef762-7a09-404c-9b7b-a1d7a33b6f88",
      "cwd": "/Users/user/projects/my-app",
      "startedAt": "2024-02-01T12:00:00.000Z",
      "status": "running",
      "threadId": "1467423768874844223",
      "command": ["node", "/path/to/dist/cli/index.js", "run", "--session-id", "e62ef762-7a09-404c-9b7b-a1d7a33b6f88", "--", "claude"],
      "lastVerified": "2024-02-01T12:05:00.000Z"
    }
  ]
}
```

### 2.2 Settings (`settings.json`)

```typescript
interface SleepCodeSettings {
  version: 1;
  allowedDirectories: string[];    // Absolute paths allowed for /claude start
  defaultDirectory?: string;       // Default if not specified
  autoCleanupOrphans: boolean;     // Auto-kill orphaned processes on startup
  maxConcurrentSessions?: number;  // Optional limit
}
```

**Example:**
```json
{
  "version": 1,
  "allowedDirectories": [
    "/Users/user/projects/app-a",
    "/Users/user/projects/app-b"
  ],
  "defaultDirectory": "/Users/user/projects/app-a",
  "autoCleanupOrphans": true,
  "maxConcurrentSessions": 5
}
```

---

## 3. Component Designs

### 3.1 ProcessManager Class

**File:** `src/discord/process-manager.ts`

```typescript
class ProcessManager {
  private registry: ProcessRegistry;
  private registryPath: string;
  private healthCheckInterval: NodeJS.Timeout | null;

  constructor(configDir: string);

  // Lifecycle
  async initialize(): Promise<void>;
  shutdown(): void;

  // Core operations
  async spawn(cwd: string, sessionId: string): Promise<ProcessEntry>;
  async kill(sessionId: string, force?: boolean): Promise<boolean>;

  // Registry management
  async getEntry(sessionId: string): Promise<ProcessEntry | undefined>;
  async getEntryByPid(pid: number): Promise<ProcessEntry | undefined>;
  async getAllRunning(): Promise<ProcessEntry[]>;
  async updateStatus(sessionId: string, status: ProcessEntry['status']): Promise<void>;
  async setThreadId(sessionId: string, threadId: string): Promise<void>;

  // Health check
  async runHealthCheck(): Promise<void>;
  private isProcessAlive(pid: number): boolean;

  // Persistence
  private async loadRegistry(): Promise<void>;
  private async saveRegistry(): Promise<void>;
}
```

**Key Implementation Details:**

1. **spawn()** - Detached process spawning:
```typescript
async spawn(cwd: string, sessionId: string): Promise<ProcessEntry> {
  const sleepCodePath = process.argv[1]; // Or configured path
  const command = ['node', sleepCodePath, 'run', '--session-id', sessionId, '--', 'claude'];

  const child = spawn(command[0], command.slice(1), {
    cwd,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  child.unref(); // Allow parent to exit independently

  const entry: ProcessEntry = {
    pid: child.pid!,
    sessionId,
    cwd,
    startedAt: new Date().toISOString(),
    status: 'starting',
    command,
  };

  this.registry.entries.push(entry);
  await this.saveRegistry();

  return entry;
}
```

2. **kill()** - Graceful termination sequence:
```typescript
async kill(sessionId: string, force = false): Promise<boolean> {
  const entry = await this.getEntry(sessionId);
  if (!entry) return false;

  try {
    if (force) {
      process.kill(entry.pid, 'SIGKILL');
    } else {
      // Graceful: SIGINT -> wait -> SIGTERM -> wait -> SIGKILL
      process.kill(entry.pid, 'SIGINT');
      await this.waitForDeath(entry.pid, 5000);

      if (this.isProcessAlive(entry.pid)) {
        process.kill(entry.pid, 'SIGTERM');
        await this.waitForDeath(entry.pid, 3000);
      }

      if (this.isProcessAlive(entry.pid)) {
        process.kill(entry.pid, 'SIGKILL');
      }
    }

    await this.updateStatus(sessionId, 'stopped');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      // Process already dead
      await this.updateStatus(sessionId, 'stopped');
      return true;
    }
    throw err;
  }
}
```

3. **Health Check** - Periodic verification:
```typescript
async runHealthCheck(): Promise<void> {
  for (const entry of this.registry.entries) {
    const alive = this.isProcessAlive(entry.pid);

    if (entry.status === 'running' && !alive) {
      // Unexpected death
      entry.status = 'orphaned';
      // Emit event for Discord notification
    }

    if (entry.status === 'starting') {
      const age = Date.now() - new Date(entry.startedAt).getTime();
      if (age > 30000) {
        // Startup timeout
        if (!alive) {
          entry.status = 'stopped';
        } else {
          // Running but never connected - mark orphaned
          entry.status = 'orphaned';
        }
      }
    }

    entry.lastVerified = new Date().toISOString();
  }

  // Clean up old stopped/orphaned entries (> 24 hours)
  this.registry.entries = this.registry.entries.filter(e => {
    if (e.status === 'stopped' || e.status === 'orphaned') {
      const age = Date.now() - new Date(e.startedAt).getTime();
      return age < 24 * 60 * 60 * 1000;
    }
    return true;
  });

  await this.saveRegistry();
}

private isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 just checks existence
    return true;
  } catch {
    return false;
  }
}
```

### 3.2 SettingsManager Class

**File:** `src/discord/settings-manager.ts`

```typescript
class SettingsManager {
  private settings: SleepCodeSettings;
  private settingsPath: string;

  constructor(configDir: string);

  async initialize(): Promise<void>;

  // Directory whitelist
  getAllowedDirectories(): string[];
  async addDirectory(path: string): Promise<boolean>;
  async removeDirectory(path: string): Promise<boolean>;
  isDirectoryAllowed(path: string): boolean;

  // Settings
  getDefaultDirectory(): string | undefined;
  async setDefaultDirectory(path: string): Promise<void>;
  getMaxSessions(): number | undefined;

  // Persistence
  private async loadSettings(): Promise<void>;
  private async saveSettings(): Promise<void>;
}
```

---

## 4. Modifications to Existing Files

### 4.1 `src/cli/run.ts`

**Change:** Accept `--session-id` argument for externally-provided session ID.

The `--session-id` flag is already implemented (used for JSONL filename). No changes needed.

### 4.2 `src/cli/index.ts`

**Change:** Parse `--session-id` before `--` separator.

```typescript
case 'run': {
  // Find -- separator
  const separatorIndex = args.indexOf('--');
  if (separatorIndex === -1) {
    console.error('Usage: sleep-code run [--session-id <uuid>] -- <command> [args...]');
    process.exit(1);
  }

  // Parse options before --
  const runOptions = args.slice(1, separatorIndex);
  let providedSessionId: string | undefined;

  const sessionIdIndex = runOptions.indexOf('--session-id');
  if (sessionIdIndex !== -1 && runOptions[sessionIdIndex + 1]) {
    providedSessionId = runOptions[sessionIdIndex + 1];
  }

  const cmd = args.slice(separatorIndex + 1);
  if (cmd.length === 0) {
    console.error('No command specified after --');
    process.exit(1);
  }

  await run(cmd, providedSessionId);
  break;
}
```

### 4.3 `src/discord/discord-app.ts`

**Change:** Add new slash commands and integrate ProcessManager.

```typescript
// New slash commands to register
const commands = [
  // ... existing commands ...
  new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Manage Claude Code sessions')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a new Claude Code session'))
    .addSubcommand(sub =>
      sub.setName('stop')
        .setDescription('Stop a running session'))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show all running sessions'))
    .addSubcommand(sub =>
      sub.setName('add-dir')
        .setDescription('Add directory to whitelist')
        .addStringOption(opt =>
          opt.setName('path')
            .setDescription('Absolute directory path')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('remove-dir')
        .setDescription('Remove directory from whitelist'))
    .addSubcommand(sub =>
      sub.setName('list-dirs')
        .setDescription('List allowed directories')),
];
```

---

## 5. Flow Diagrams

### 5.1 Session Start Flow (`/claude start`)

```
User                Discord Bot              ProcessManager         run.ts Process
  │                      │                         │                      │
  │ /claude start        │                         │                      │
  │─────────────────────►│                         │                      │
  │                      │                         │                      │
  │                      │ show directory dropdown │                      │
  │◄─────────────────────│                         │                      │
  │                      │                         │                      │
  │ select directory     │                         │                      │
  │─────────────────────►│                         │                      │
  │                      │                         │                      │
  │                      │ generate sessionId      │                      │
  │                      │ spawn(cwd, sessionId)   │                      │
  │                      │─────────────────────────►                      │
  │                      │                         │ child.spawn(...)    │
  │                      │                         │─────────────────────►│
  │                      │                         │     returns PID      │
  │                      │ ProcessEntry{starting}  │◄─────────────────────│
  │                      │◄─────────────────────────                      │
  │                      │                         │                      │
  │   "Starting..."      │                         │                      │
  │◄─────────────────────│                         │                      │
  │                      │                         │                      │
  │                      │                         │     session_start    │
  │                      │         (socket)        │◄─────────────────────│
  │                      │◄────────────────────────│                      │
  │                      │                         │                      │
  │                      │ updateStatus(running)   │                      │
  │                      │─────────────────────────►                      │
  │                      │                         │                      │
  │                      │ create Discord thread   │                      │
  │   Thread created     │                         │                      │
  │◄─────────────────────│                         │                      │
```

### 5.2 Session Stop Flow (`/claude stop`)

```
User                Discord Bot              ProcessManager            run.ts
  │                      │                         │                      │
  │ /claude stop         │                         │                      │
  │─────────────────────►│                         │                      │
  │                      │                         │                      │
  │                      │ show session dropdown   │                      │
  │◄─────────────────────│                         │                      │
  │                      │                         │                      │
  │ select session       │                         │                      │
  │─────────────────────►│                         │                      │
  │                      │                         │                      │
  │                      │ kill(sessionId)         │                      │
  │                      │─────────────────────────►                      │
  │                      │                         │    SIGINT            │
  │                      │                         │─────────────────────►│
  │                      │                         │                      │
  │                      │                         │   (graceful exit)    │
  │                      │                         │    session_end       │
  │                      │         (socket)        │◄─────────────────────│
  │                      │◄────────────────────────│                      │
  │                      │                         │                      │
  │                      │ updateStatus(stopped)   │                      │
  │                      │─────────────────────────►                      │
  │   "Session stopped"  │                         │                      │
  │◄─────────────────────│                         │                      │
```

### 5.3 Bot Restart Recovery Flow

```
Bot Restart              ProcessManager         SessionManager         run.ts (running)
     │                        │                       │                      │
     │ initialize()           │                       │                      │
     │───────────────────────►│                       │                      │
     │                        │                       │                      │
     │                        │ loadRegistry()        │                      │
     │                        │─────────┐             │                      │
     │                        │◄────────┘             │                      │
     │                        │                       │                      │
     │                        │ for each entry:       │                      │
     │                        │  isProcessAlive(pid)  │                      │
     │                        │─────────┐             │                      │
     │                        │◄────────┘             │                      │
     │                        │                       │                      │
     │                        │ mark dead as stopped  │                      │
     │                        │ keep alive entries    │                      │
     │                        │                       │                      │
     │ sessionManager.start() │                       │                      │
     │───────────────────────────────────────────────►│                      │
     │                        │                       │                      │
     │                        │                       │ (reconnect attempt)  │
     │                        │                       │◄─────────────────────│
     │                        │                       │                      │
     │                        │                       │   session_start      │
     │                        │     onSessionStart()  │◄─────────────────────│
     │                        │◄──────────────────────│                      │
     │                        │                       │                      │
     │                        │ correlate by sessionId│                      │
     │                        │ confirm running       │                      │
```

---

## 6. Edge Cases and Handling

| Edge Case | Detection | Handling |
|-----------|-----------|----------|
| Process crashes without session_end | Health check: PID dead but status=running | Mark orphaned, notify Discord |
| Bot restarts while sessions run | On startup: PID exists in registry | Wait for reconnect via socket |
| PID reused by OS | session_start has different sessionId | Reject, clean registry entry |
| Directory deleted while running | PTY/JSONL errors | Process crashes, handled as crash |
| Duplicate session in same directory | Check registry for cwd | Allow (multiple sessions) |
| Socket file stale after crash | ECONNREFUSED | DaemonConnection auto-reconnects |
| Spawn fails immediately | child.pid undefined | Return error, don't add to registry |
| User starts session manually | session_start without registry | Add to registry retroactively |
| Health check during shutdown | Race condition | Lock registry during operations |

---

## 7. Implementation Sequence

### Phase 1: Core Infrastructure
1. Create `src/discord/process-manager.ts`
2. Create `src/discord/settings-manager.ts`
3. Test spawn/kill independently

### Phase 2: Discord Integration
4. Add `/claude` slash commands
5. Wire ProcessManager to commands
6. Add select menus for directory/session

### Phase 3: Reliability
7. Implement startup recovery
8. Add health check (60-second interval)
9. Handle edge cases

### Phase 4: Polish
10. `/claude status` with rich embeds
11. Error messages
12. Documentation

---

## 8. Files Summary

### New Files
- `src/discord/process-manager.ts` (~200 lines)
- `src/discord/settings-manager.ts` (~100 lines)

### Modified Files
- `src/cli/index.ts` - Parse `--session-id` (~15 lines)
- `src/discord/discord-app.ts` - Add `/claude` commands (~150 lines)
- `src/cli/discord.ts` - Initialize managers (~30 lines)
