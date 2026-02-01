# Bug Report: Some assistant messages not written to session JSONL file

**Status:** Draft - Not yet submitted

## Summary

Some assistant text messages are not written to the session JSONL file (`~/.claude/projects/*/session.jsonl`), even though they are displayed in the terminal. This makes it impossible for external tools to reliably monitor Claude Code sessions via JSONL.

## Environment

- **Claude Code version**: 2.1.29
- **OS**: macOS Darwin 24.5.0 (Apple Silicon)
- **Terminal**: iTerm2 / Apple Terminal

## Steps to Reproduce

1. Start a Claude Code session with `--session-id` flag
2. Have Claude respond with tool calls (e.g., Bash, Edit, Write)
3. After the tool result, Claude responds with a short text message
4. Check the JSONL file for the assistant message

## Observed Behavior

The short text response after tool results is sometimes missing from the JSONL file:

```bash
# Terminal showed message "[027] 잘 작동하네요! ..."
# But JSONL search returns nothing:
$ grep '\[027\]' ~/.claude/projects/*/e62ef762-*.jsonl
# No results - only references from LATER messages mentioning [027]
```

The message sequence in JSONL jumps from `[026]` directly to `[028]`, while `[027]` was clearly displayed in the terminal.

## Expected Behavior

All assistant messages displayed in the terminal should be written to the JSONL file.

## Impact

- External tools monitoring JSONL (Slack/Discord/Telegram bots, IDE integrations) miss messages
- No alternative structured output source available
- PTY stdout parsing is unreliable due to ANSI codes and character-by-character streaming

## Pattern Observed

Messages are more likely to be missing when:
- Short text responses (1-2 sentences)
- Immediately after tool results
- Possibly after extended thinking time

## Additional Context

We're building a Discord bot that monitors Claude Code sessions via JSONL. This missing message issue causes users to miss important responses.

---

## Reproduction Test

See [jsonl-missing-messages-repro.md](./jsonl-missing-messages-repro.md) for a reproducible test prompt.
