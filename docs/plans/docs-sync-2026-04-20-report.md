# Docs Sync Report 2026-04-20

## Scope

SDK model/context selection, `[1m]` suffix usage, lazy resume model persistence, and per-turn model breakdown documentation were synced to the current implementation.

## Updated Files

| File | Sections Updated | Summary |
|------|------------------|---------|
| `docs/sdk-session.md` | Quick Start, Model Selection, Context Usage, Session Management, Configuration, Bot Restart & Lazy Resume, Troubleshooting | Updated `/claude start-sdk` to 2-step selection, added model matrix and `[1m]` rule, documented per-turn breakdown format and primary model rule, clarified `sdkDefaultModel` override + `sdkModel` persistence, and added restart fallback troubleshooting for pre-`9a2be38` sessions. |
| `docs/commands.md` | Discord Commands > Session Management | Expanded `/claude start-sdk` description to model/context → directory flow and linked to SDK model selection details. |
| `CLAUDE.md` | ChannelManager, ClaudeSdkSessionManager, Multi-Agent table | Added `sdkModel` persistence, model/context selection support, per-turn primary model + breakdown behavior, and refreshed Claude model list. |
| `AGENTS.md` | Multi-Agent table | Synced Claude model list with `CLAUDE.md`. |
| `docs/architecture.md` | ClaudeSdkSessionManager | Added restart-persisted model/context selection note. |
| `README.md` | Features | Added model/context selection feature bullet. |
| `README.ko.md` | 주요 기능 | Added Korean feature bullet matching the English README. |

## Validation Notes

- `docs/commands.md` remains the canonical command reference; `docs/sdk-session.md` now points back to it for command descriptions.
- `CLAUDE.md` remains the canonical config/environment reference; `docs/sdk-session.md` now points back to it instead of duplicating tables.
- `[1m]` suffix examples use the Claude Code model ID format consistently.
- Pre-`9a2be38` session fallback behavior is explicitly documented in `docs/sdk-session.md`.
- English and Korean README feature bullets were kept semantically aligned.

## Pending

- No commit created.
- Build verification still needs to be run after documentation edits.
