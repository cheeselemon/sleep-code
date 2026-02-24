# Codex Integration

Sleep Code can run and control OpenAI Codex CLI sessions alongside Claude Code sessions in Discord. Unlike Claude which operates via PTY + JSONL, Codex is controlled programmatically using `@openai/codex-sdk` directly.

## Setup

### Authentication

One of the following is required:

1. **OPENAI_API_KEY environment variable** - Set in `.env` file or system environment
2. **Codex OAuth** - Run `codex login` to auto-generate `~/.codex/auth.json`

Auto-detected on bot startup. If neither is available, Codex is disabled.

```
// src/cli/discord.ts
const openaiKey = config.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
const codexAuthFile = `${homedir()}/.codex/auth.json`;
const enableCodex = hasCodexOAuth || !!openaiKey;
```

### Verifying Codex is enabled

Check bot logs:
- `Codex enabled via OAuth (~/.codex/auth.json)` - OAuth auth
- `Codex enabled via API key` - API key auth
- `No Codex auth found (run codex login or set OPENAI_API_KEY), Codex disabled` - Disabled

## Discord Commands

### `/codex start`

Starts a new Codex session. A dropdown menu for selecting from allowed directories is shown.

- Directories must be registered beforehand with `/claude add-dir`
- Shares the same directory whitelist as Claude
- Creates a new Discord thread and starts the session

### `/codex stop`

Stops a running Codex session. A session selection dropdown is shown; the current thread's session is marked with a star.

- Active turns are aborted if running
- Thread is archived (only if no Claude session exists in the same thread)

### `/codex status`

Displays all Codex sessions in an embed card.

| Status | Icon | Description |
|--------|------|-------------|
| starting | 🔄 | Session starting |
| running | 🟢 | Turn executing |
| idle | 🟡 | Waiting for input |
| ended | ⚫ | Terminated |

## Message Routing

### Single-agent threads

- Claude-only thread: All messages route to Claude
- Codex-only thread: All messages route to Codex

### Multi-agent threads

When both Claude and Codex are in the same thread:

1. **Default behavior**: Messages are sent to the last active agent
2. **Explicit prefixes**: Use a prefix to specify the target agent

| Prefix | Target | Example |
|--------|--------|---------|
| `c:` or `claude:` | Claude | `c: explain this code` |
| `x:` or `codex:` | Codex | `x: run the tests` |
| (none) | Last active agent | `fix the bug` |

Prefixes are case-insensitive.

### Auto Codex session creation

Using the `x:` prefix in a Claude-only thread will automatically create a Codex session in that thread. It inherits the working directory from the Claude session.

## Architecture

```
src/discord/codex/
├── codex-session-manager.ts   # SDK session management, streaming turn processing
└── codex-handlers.ts          # Codex events → Discord message conversion
```

### CodexSessionManager

Manages the lifecycle of Codex SDK sessions.

```typescript
class CodexSessionManager {
  startSession(cwd, discordThreadId)  // Start new session
  sendInput(sessionId, prompt)        // Send user input (streaming)
  stopSession(sessionId)              // Stop session (includes abort)
  getSession(sessionId)               // Get session by ID
  getSessionByDiscordThread(threadId) // Get session by Discord thread
  getAllSessions()                     // List all sessions
}
```

Key configuration:
- `approval_policy: 'never'` - Auto-approve all operations (no interactive approval)
- Concurrent turn prevention - New input rejected while `status === 'running'`

### Event System

Session events are handled via the `CodexEvents` interface:

| Event | Description | Discord Display |
|-------|-------------|-----------------|
| `onMessage` | Agent text response | Plain message (`**Codex:**` prefix in multi-agent threads) |
| `onCommandExecution` | Command execution | Code block (`$ command` + output + exit code) |
| `onFileChange` | File changes | `📝 File changes:` + file list with diff preview |
| `onError` | Error occurred | `❌ **Codex Error:** {message}` |
| `onSessionStatus` | Status change | Typing indicator start/stop |

### Streaming

`processStreamedTurn()` uses the Codex SDK streaming API:

```
thread.runStreamed(prompt)
  → thread.started     // Capture thread ID
  → item.completed     // agent_message, command_execution, file_change
  → turn.completed     // Log token usage
  → error              // Propagate errors
```

Each turn is abortable via `AbortController`. Active turns are aborted on `/codex stop`.

### ChannelManager Extensions

Codex sessions are managed in separate maps from Claude sessions:

```typescript
// Codex-specific methods
createCodexSession(sessionId, name, cwd, existingThreadId?)
getCodexSession(sessionId)
updateCodexSessionId(oldId, newId)
getCodexSessionByThread(threadId)
getAgentsInThread(threadId)  // { claude?: string, codex?: string }
archiveCodexSession(sessionId)
```

Session mappings are persisted separately in `codex-session-mappings.json`.

## Differences from Claude

| | Claude Code | Codex |
|---|---|---|
| Communication | PTY + Unix socket + JSONL | Direct SDK calls |
| Permissions | Permission hook (interactive buttons) | `approval_policy: 'never'` (auto-approve) |
| YOLO mode | Toggle with `/yolo-sleep` | Always auto-approve |
| Session recovery | JSONL-based recovery | In-memory only, lost on bot restart |
| Process | Separate terminal/background process | SDK thread within bot process |
| Event format | JSONL file watching (chokidar) | SDK streaming events |

## Limitations

- Codex sessions are not recoverable after bot restart (unlike Claude which has JSONL files)
- Command output is truncated to 1500 characters
- File diff previews are truncated to 200 characters
- Codex always runs in auto-approve mode (no permission request UI)
- Only one turn can be processed at a time (new input rejected until previous turn completes)
