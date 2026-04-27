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

Starts a new Codex session via a **2-step menu**:

1. **Pick model + reasoning effort**: 9 options (e.g. `GPT-5.5 (high)`, `GPT-5.4-mini (medium)`)
2. **Pick directory**: from the whitelisted set

Both selections pin to the session and survive bot restart (persisted in `codex-session-mappings.json`).

The `/codex start` menu currently offers these 9 model+effort combinations:

| Model | Available efforts in `/codex start` | Notes |
|-------|--------------------------------------|-------|
| `gpt-5.5` | low / medium / high / xhigh | Frontier · default `high` · `xhigh` = deepest reasoning |
| `gpt-5.4` | medium / high | Previous generation |
| `gpt-5.4-mini` | medium | Smaller · faster · cheaper |
| `gpt-5.3-codex` | high | Coding-specialized |
| `gpt-5.2` | medium | Legacy |

After a session starts, `/codex intelligence` exposes the full effort range (`minimal / low / medium / high / xhigh`) for the active model.

- Directories must be registered beforehand with `/claude add-dir`
- Shares the same directory whitelist as Claude
- Creates a new Discord thread and starts the session

### `/codex stop`

Stops a running Codex session. A session selection dropdown is shown; the current thread's session is marked with a star.

- Active turns are aborted if running
- Thread is archived (only if no Claude session exists in the same thread)
- Any queued messages are discarded (logged with drop count)

### `/codex intelligence`

Switches the reasoning effort of the Codex session in the current thread **on the fly** with no context loss.

- Current effort is shown as the default-selected option
- Aborts the active turn (if any), then resumes the thread (`resumeThread()`) with the new effort
- Model, sandbox mode, and cwd are preserved
- No-op when the same effort is selected

```
/codex intelligence
  → "🧠 Change Codex Reasoning Effort
     Model: gpt-5.5 · Current: high"
  → pick new effort from dropdown
  → ✅ "GPT-5.5 · high → xhigh"
```

### `/codex status`

Displays all Codex sessions in an embed card.

| Status | Icon | Description |
|--------|------|-------------|
| starting | 🔄 | Session starting |
| running | 🟢 | Turn executing |
| idle | 🟡 | Waiting for input |
| ended | ⚫ | Terminated |

### `/yolo-sleep` (in a Codex thread)

Toggles YOLO. Codex sandbox mode flips together:

- ON → `workspace-write` (file mutations allowed)
- OFF → `read-only`

Active turn is aborted and the thread resumes with the new sandbox.

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
  startSession(cwd, discordThreadId, { sandboxMode?, model?, modelReasoningEffort? })
  sendInput(sessionId, prompt)        // Queue + auto-drain
  stopSession(sessionId)              // Stop (drops queue, aborts active turn)
  switchSandboxMode(sessionId, newMode)        // Called by /yolo-sleep
  switchReasoningEffort(sessionId, newEffort)  // Called by /codex intelligence
  interruptSession(sessionId)         // Aborts active turn only (session stays)
  restoreSessions(mappings)           // Bot restart (passes workingDirectory)
  getSession(sessionId)
  getSessionByDiscordThread(threadId)
  getAllSessions()
}
```

Key configuration:
- `approval_policy: 'never'` - Auto-approve all operations (no interactive approval)
- Model + reasoning effort pinned on the session entry — preserved across `restoreSessions` and `switchSandboxMode`
- Input queueing - messages received during an active turn are queued (cap 10) and merged with `\n\n` into a single follow-up turn when the active turn ends

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
| Session recovery | JSONL-based recovery | `codexThreadId` persisted, `resumeThread()` on bot restart |
| Process | Separate terminal/background process | SDK thread within bot process |
| Event format | JSONL file watching (chokidar) | SDK streaming events |

## Limitations

- Codex sessions auto-recover after bot restart via persisted `codexThreadId` and `resumeThread()`
- Sandbox mode resets to `read-only` after restart (YOLO state is not separately persisted)
- Command output is truncated to 1500 characters
- File diff previews are truncated to 200 characters
- Codex always runs in auto-approve mode (no permission request UI)
- Input queue cap = 10 — message #11 is rejected (`session busy or ended` reply)
- Only one turn runs at a time, but additional messages are queued and auto-drained, so the user side never loses input
