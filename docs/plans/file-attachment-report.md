# File Attachment Report

## Completed Work

- Added `src/discord/attach-store.ts` to persist attach-button state in `~/.sleep-code/attach-buttons.json`, restore timers on bot startup, and disable expired buttons after 1 hour.
- Added `src/discord/interactions/attach-button.ts` to handle `attach:<uuid>` clicks with CWD boundary checks, symlink-safe `fs.realpathSync()` validation, 25MB size checks, upload-on-click, and re-click URL reuse.
- Extended `src/discord/claude-sdk/claude-sdk-handlers.ts` to parse `<attach>/abs/path</attach>` markers from Claude SDK responses only, strip markers from visible text, render up to 5 file buttons, and log overflow markers.
- Wired the new store through `src/discord/discord-app.ts`, `src/discord/interactions/index.ts`, `src/discord/interactions/types.ts`, and `src/discord/commands/types.ts`.
- Added shared attachment path validation helpers to `src/discord/utils.ts`.
- Documented the marker contract in `AGENTS.md` and added an SDK-session mention to `docs/sdk-session.md`.
- Synced the installer templates in `docs/skills/install.md` and `.claude/commands/sc-install.md` with a new `## File Delivery via \`<attach>\` Marker` section.

## Manual Test Procedure

1. Start a Claude SDK session with `/claude start-sdk` in a test thread.
2. Have Claude respond with a valid marker such as `<attach>/absolute/path/inside/cwd/test.pdf</attach>`.
3. Confirm Discord renders a file button labeled with basename only, not the full path.
4. Click the button once and confirm the file is uploaded into the thread as an attachment.
5. Click the same button again and confirm the bot replies with the existing uploaded message URL instead of uploading a second copy.
6. Test a CWD escape path, including a symlink or `..` path that resolves outside the session CWD, and confirm the bot rejects it.
7. Test a missing file by deleting the file after the button is rendered, then clicking it and confirming the missing-file error.
8. Test a file larger than 25MB and confirm the size error includes the actual size in MB.
9. Emit 6 or more `<attach>` markers in one response and confirm only the first 5 buttons render.
10. Wait 1 hour or reduce TTL locally for testing, then confirm the buttons become disabled and marked expired.
11. Restart the bot before expiry and confirm persisted buttons still work and expiry timers are restored.

## Validation

- `npm run build` succeeded.

## Notes

- Scope is Claude SDK responses only. PTY Claude sessions and Codex outputs were not changed.
- The repository copies of the installer template were updated, but `~/.claude/commands/sc-install.md` could not be modified from this session because that path is outside the writable sandbox roots.
