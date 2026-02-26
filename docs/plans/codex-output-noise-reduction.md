# Codex Discord Output Noise Reduction

## Problem

Codex shell commands display the **full raw command** in Discord, including heredoc content.
Example: `⚙️ /bin/zsh -lc "cat > file.md <<'EOF' ... 200 lines ... EOF"` floods the thread.

Claude tool calls are summarized (`🔧 **Write**: path/to/file`), but Codex has no such filtering.

## Current Behavior (codex-handlers.ts)

### onCommandExecution (line 131-157)
- Success: `⚙️ \`{full command}\` (done, 1.2s)` — no truncation on command itself
- Error: same + first 500 chars of output

### onFileChange (line 159-180)
- `📝 N files changed: file1, file2, ...` — this is fine

### onMessage (line 92-129)
- Shows full message — this is fine (it's Codex's actual response text)

## Proposed Fix

### 1. Truncate command display in onCommandExecution

```typescript
// Truncate long commands (heredocs, base64, etc.)
const MAX_CMD_DISPLAY = 120;
let displayCmd = info.command;
if (displayCmd.length > MAX_CMD_DISPLAY) {
  displayCmd = displayCmd.slice(0, MAX_CMD_DISPLAY) + '...';
}
```

### 2. Detect and summarize file-write commands

When the command is a file write (heredoc, echo/cat redirect), show it like Claude does:

```typescript
// Detect file write patterns: cat > file <<, echo > file, tee file
const fileWriteMatch = info.command.match(
  /(?:cat|tee)\s+>?\s*(\S+)\s*<<|>\s*(\S+)/
);
if (fileWriteMatch) {
  const filePath = fileWriteMatch[1] || fileWriteMatch[2];
  displayCmd = `write → ${filePath}`;
}
```

### 3. Collapse successful commands by default

For non-error commands, show just the summary. Only expand on error.

## File to Edit

`src/discord/codex/codex-handlers.ts` — `onCommandExecution` handler

## Acceptance Criteria

- [ ] Long heredoc commands show truncated/summarized display
- [ ] File write commands show `write → path` instead of full heredoc
- [ ] Error commands still show output (truncated)
- [ ] `npm run build` passes
