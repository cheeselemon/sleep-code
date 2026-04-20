# Claude Agent SDK Session Guide

## Overview

Sleep Code can run Claude sessions in two ways:

| | PTY (classic) | SDK (new) |
|---|---|---|
| Start command | `/claude start` | `/claude start-sdk` |
| Process | External CLI + Unix socket | In-process (Agent SDK) |
| Output | JSONL file watching (indirect) | async iterable (direct) |
| Input | socket → PTY stdin | async generator yield |
| Permissions | hook binary → socket → daemon | `canUseTool` callback (Promise) |
| Resume | CLI `--resume` | `resume: sdkSessionId` (lazy resume: auto-recovers on next message after bot restart) |
| Dependencies | node-pty, chokidar, Unix socket | `@anthropic-ai/claude-agent-sdk` |
| Auth | CLI inherited | `claude login` OAuth (Max subscription) |

**When to use SDK?**

- Want a lightweight setup without PTY
- Having node-pty compile issues
- Want structured tool call/result directly

**When to use PTY?**

- Need terminal controls (`/background`, `/mode`, `/compact`)
- Want to keep your existing workflow

---

## Quick Start

### 1. Prerequisites

```bash
# Claude Agent SDK package (already included)
npm install @anthropic-ai/claude-agent-sdk

# Claude CLI authentication (OAuth)
claude login
```

### 2. Start a Session

In Discord:

```
/claude start-sdk
```

→ Step 1: Select a model + context window.

→ Step 2: Select a directory from your whitelisted directories.

After both steps, an SDK session starts in that thread:

```
📡 Claude SDK ready
Directory: /Users/you/project
```

### 3. Send Messages

Type messages in the thread and they are forwarded to Claude. Multi-turn conversation is maintained automatically.

```
You: Analyze src/index.ts
Claude: (responds)
You: Suggest a refactor
Claude: (responds with previous context preserved)
```

### 4. End Session

```
/claude stop
```

---

## Model Selection

`/claude start-sdk` uses a 2-step picker:

1. Select the model + context window.
2. Select the directory.

### Available Models

| Model | 200K | 1M |
|-------|:----:|:--:|
| Claude Opus 4.7 | ✅ | ✅ |
| Claude Opus 4.6 | ✅ | ✅ |
| Claude Sonnet 4.6 | ✅ | ✅ |
| Claude Haiku 4.5 | ✅ | ❌ |

### 1M Context Rule

- Use the Claude Code model ID with a `[1m]` suffix, for example `claude-opus-4-7[1m]`.
- This matches the Claude Code CLI `/model` format.
- 1M context is enabled by the model ID itself, not by a `betas` flag.

### Notes

- Haiku 4.5 does not have a 1M variant.
- Opus and Sonnet 1M variants may have separate billing.
- Full slash command reference remains in [Commands Reference](commands.md).

---

## Permission Handling

When Claude tries to use a tool in an SDK session, permission request buttons appear in Discord:

```
🔐 Permission Request: Bash
`npm install express`

[Allow] [🔥 YOLO] [Deny]
```

| Button | Action |
|--------|--------|
| **Allow** | Approve this request only |
| **🔥 YOLO** | Approve this request + auto-approve all future requests |
| **Deny** | Deny the request |

### YOLO Mode

Activate with `/yolo-sleep` or the YOLO button. When active:

- All tool calls are auto-approved
- `🔥 **YOLO**: Auto-approved \`Bash\`` notifications are shown
- `ExitPlanMode` is excluded from YOLO

### Permission Timeout

By default, permission requests wait indefinitely (no timeout). To enable auto-deny after a timeout, set `sdkPermissionTimeoutMs` in `~/.sleep-code/settings.json`:

```json
{
  "sdkPermissionTimeoutMs": 300000
}
```

---

## Tool Display

SDK sessions display tool calls and results in a structured format.

### Tool Call

```
🔧 Bash: `npm test`
🔧 Read: `/src/index.ts`
🔧 Grep: `handlePermission`
🔧 Write: `/src/new-file.ts`
```

### Tool Result

- Short results: shown inline
- Over 300 chars: truncated preview + **[View Full]** button
- Write/Edit tools: file uploaded as Discord attachment

```
✅ Result:
```
PASS src/index.test.ts
  ✓ should work (3ms)
```
```

### Context Usage

Context window usage is displayed after each turn:

```
🟢 14% ctx (28.4k/1.0M) · $0.1790 · turn 1
🤖 claude-opus-4-7[1m]: 28.4k · claude-haiku-4-5: 2.1k
```

| Icon | Meaning |
|------|---------|
| 🟢 | Under 70% — plenty of room |
| 🟡 | 70–89% — caution |
| 🔴 | 90%+ — compaction needed soon |

- **Line 1**: Current turn context usage, cumulative session cost, and turn number
- **Line 2**: Per-model token breakdown for that turn
- **ctx %**: Per-API-call `input_tokens + cache_read + cache_creation` divided by the current `contextWindow`
- **$**: Cumulative session cost
- **turn**: Current turn number
- **primary model**: The model selected at `/claude start-sdk` time (pinned across turns and always rendered first in the breakdown). Falls back to the highest-token model only when the selected one isn't present in a given turn's `modelUsage`.

> **Note:** It is normal to see `claude-haiku-4-5` in the breakdown even when the main reply came from Opus or Sonnet. The SDK may use Haiku as a sidecar model for compaction or summarization.

---

## Session Management

### Session States

| State | Description |
|-------|-------------|
| `idle` | Waiting for input |
| `running` | Claude is responding / executing tools (typing indicator shown) |
| `ended` | Session terminated |

### Commands

| Command | SDK Support | Description |
|---------|:----------:|-------------|
| `/claude start-sdk` | ✅ | Start SDK session |
| `/claude stop` | ✅ | End session |
| `/claude status` | ✅ | List sessions (📡 SDK / 🔧 PTY) |
| `/interrupt` | ✅ | Abort current turn (session stays alive) |
| `/yolo-sleep` | ✅ | Toggle YOLO mode |
| `/panel` | ✅ | Show interrupt + YOLO buttons |
| `/background` | ❌ | Not supported (terminal only) |
| `/mode` | ❌ | Not supported (terminal only) |
| `/compact` | ❌ | Not supported (SDK manages internally) |
| `/model` | ⚠️ | Applied from next turn |

> **Note:** SDK sessions start with `settingSources: ['user', 'project', 'local']`, auto-loading CLAUDE.md, `~/.claude/settings.json`, and project `.claude/` settings.
>
> Canonical command descriptions live in [Commands Reference](commands.md).

### Interrupt vs Stop

- **Interrupt** (`/interrupt`): Aborts only the current turn. Session returns to `idle` and waits for the next input.
- **Stop** (`/claude stop`): Terminates the entire session. All pending permission requests are auto-denied.

---

## Multi-Agent

SDK sessions can coexist with Codex in the same thread.

### Message Routing

```
c: explain this code       → Sent to Claude (SDK)
x: run the tests           → Sent to Codex
(no prefix)                → Sent to last active agent
```

### Limitations

- PTY and SDK sessions cannot coexist in the same thread
- Using `x:` prefix in a thread without Codex auto-creates a Codex session

---

## Memory Integration

Claude responses from SDK sessions are automatically collected into the memory pipeline.

- Recorded with `speaker: 'claude'`
- Project name extracted from the session's working directory (`cwd`)
- Disable memory: `DISABLE_MEMORY=1` environment variable

---

## Configuration

Canonical config and environment variable reference lives in [CLAUDE.md](../CLAUDE.md).

- `sdkDefaultModel` is the default SDK model when no explicit session selection overrides it.
- In `/claude start-sdk`, Step 1 model selection overrides `sdkDefaultModel` for that session.
- The selected model ID is persisted as `sdkModel` in the session mapping so lazy resume can restore the same model + context window later.

---

## Bot Restart & Lazy Resume

SDK sessions **auto-recover without any command** after a bot restart.

### How It Works

1. On bot startup, `sdk-session-mappings.json` is loaded → `sdkSessions` + `sdkPersistedMappings` restored
2. Broken mappings auto-cleaned (removes entries where `sdkSessionId === sessionId`, deduplicates per thread)
3. User sends a message in an existing thread
4. Lazy resume triggers: `query({ resume: sdkSessionId })` loads JSONL history
5. Responds with full conversation context preserved

### ID Distinction (Important)

| ID | Purpose | Example |
|----|---------|---------|
| `sessionId` | Sleep Code internal (Discord thread mapping) | `a8864f1b-...` |
| `sdkSessionId` | Claude Agent SDK (used in `query({ resume })`) | `995b99cd-...` |

These IDs are separate. `sdkSessionId` is used by the SDK as the JSONL filename and must be passed for resume.

### Model Persistence

- Lazy resume also restores the selected model variant from the persisted `sdkModel` mapping.
- If a session was started with `claude-opus-4-7[1m]`, the same `claude-opus-4-7[1m]` model is sent again after bot restart.
- Sessions started before patch `9a2be38` do not have `sdkModel` stored in the persisted mapping.
- Those older sessions fall back to the 200K variant after restart and must be restarted with `/claude start-sdk`.

### Resume Failure

Lazy resume fails → auto-attempts fresh start → if that also fails, user is prompted to run `/claude start-sdk` manually.

---

## Troubleshooting

### "No active session in this channel"

The SDK session has not started or has ended in this thread. After a bot restart, try sending a message (triggers lazy resume). If that doesn't work, start a new session with `/claude start-sdk`.

### OAuth Authentication Error

```bash
claude login    # Re-authenticate in CLI
```

SDK sessions require Claude Max subscription OAuth authentication.

### Permissions Keep Timing Out

Increase `sdkPermissionTimeoutMs` or use YOLO mode.

### `/background`, `/compact` Not Working

These commands are PTY-only. They are not supported in SDK sessions.

### No Response After Bot Restart

1. Try sending a message → triggers lazy resume
2. Check logs: `pm2 logs sleep-discord --lines 30 --nostream`
3. If you see `Lazy-resuming SDK session` — normal (SDK is loading)
4. If you see `Fresh start also failed` — start a new session with `/claude start-sdk`

### Context Fell Back to 200K After Bot Restart

Cause: the session was started before patch `9a2be38`, so its persisted mapping does not contain `sdkModel`.

Fix: start a new SDK session with `/claude start-sdk` and choose the desired 1M variant again.

### Session Ended Unexpectedly

Check the logs:

```bash
pm2 logs sleep-discord    # When using PM2
# or
npm run discord           # Check console output when running directly
```

If you see `Claude SDK query ended unexpectedly.`, it may be a network issue or an SDK error.
