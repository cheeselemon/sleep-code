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
- **Immediately after Bash tool results** (confirmed trigger)
- NOT language-specific (both Korean and English affected)
- NOT length-specific (both short and long responses affected)
- NOT format-specific (both plain text and markdown affected)

### Confirmed Missing Messages

| Index | Trigger | Content Length | Language | Markdown |
|-------|---------|----------------|----------|----------|
| [027] | After Bash (sleep) | Short | Korean | No |
| [046] | After Bash (git add && commit) | Long | Korean | Yes |
| [049] | After Bash (grep) | Long | Korean | Yes |
| [052] | After Bash (grep) | Long | Korean | Yes |
| [057] | After Bash (grep) | Long | English | Yes (table) |
| [058] | After Bash (wc -l) | Short ("check") | English | No |

### Key Finding

**Language does NOT matter.** Both Korean and English messages are dropped.

The common pattern is:
1. Bash tool execution completes
2. Assistant responds with text (any language, any length)
3. Message is displayed in terminal but NOT written to JSONL

The issue appears to be timing-related with Bash tool results, not content-related.

## Additional Context

We're building a Discord bot that monitors Claude Code sessions via JSONL. This missing message issue causes users to miss important responses.

Tested with English-only responses - same issue occurs. Language is NOT a factor.

---

## Reproduction Test

See [jsonl-missing-messages-repro.md](./jsonl-missing-messages-repro.md) for a reproducible test prompt.
