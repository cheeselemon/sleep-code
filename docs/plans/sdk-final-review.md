# SDK Final Review

## Findings

### 1. High: SDK "restore" does not restore prior conversation state, and it does not rebuild the Discord thread mapping needed for handler delivery

`src/discord/interactions/restore.ts:117-137` reads the persisted SDK mapping, but then calls `claudeSdkSessionManager.startSession(mapping.cwd, mapping.threadId, { sessionId: mapping.sessionId })`. That only reuses the local Sleep Code session ID. It does not use `mapping.sdkSessionId`, and `src/discord/claude-sdk/claude-sdk-session-manager.ts:302-313` does not call any SDK resume API either, so this starts a fresh SDK session rather than restoring the previous one.

There is a second breakage on top of that: after a bot restart, the thread lookup in `src/discord/claude-sdk/claude-sdk-handlers.ts:37-40` depends on `channelManager.getSdkSession(sessionId)`, but the restore path never recreates the in-memory SDK mapping. `src/discord/channel-manager.ts` has a Codex restore helper at `:885-903`, but no SDK equivalent. That means a "restored" SDK session can run without any of its Discord events finding the thread.

### 2. High: reboot-time SDK dismiss and auto-dismiss do not actually clean persisted mappings

Both the button path in `src/discord/interactions/restore.ts:153-176` and the startup auto-dismiss path in `src/cli/discord.ts:437-455` call `channelManager.archiveSdkSession(sessionId)`. But `src/discord/channel-manager.ts:683-708` only works when the session still exists in `sdkSessions`; it returns `false` immediately for persisted-only mappings after restart.

That means the reboot recovery flow can archive the thread message-wise while leaving `sdk-session-mappings.json` untouched. On the next restart, the same dead SDK session is eligible for another restore offer. This is the biggest cleanup gap in the current implementation.

### 3. Medium: explicit SDK stop only stops the SDK manager, not the channel-manager mapping lifecycle

`src/discord/interactions/select-menus.ts:98-103` stops SDK sessions by calling `claudeSdkSessionManager.stopSession(sessionId)` only. `src/discord/claude-sdk/claude-sdk-session-manager.ts:415-427` then removes the session from its own map and emits `onSessionEnd`, but `src/discord/claude-sdk/claude-sdk-handlers.ts:79-96` only posts a Discord message. Nothing archives or removes the SDK mapping from `ChannelManager`.

The result is stale SDK state in `threadToSdkSession` / `sdkPersistedMappings` even after a user explicitly stops the session. In practice this can keep Claude marked as present in a thread, cause restore prompts for already-stopped SDK sessions, and make routing/state inspection inconsistent with the real session state.

### 4. Medium: the new transport abstraction is only partially wired, so SDK sessions still behave differently from PTY sessions in command resolution

`src/discord/commands/helpers.ts:35-45` resolves SDK transport only by exact thread ID via `getSessionByThread(channelId)`, then falls back to the old PTY-only `getSessionFromChannel()`. That leaves parent-channel resolution PTY-only.

You can see the same assumption in `src/discord/commands/claude.ts:148-159`, where `/claude stop` uses `channelManager.getSessionByChannel(interaction.channelId)` to find the "current" session. SDK sessions never participate in that path, so the current-session sort/highlight is wrong for SDK threads/channels even though the stop menu itself includes SDK entries.

### 5. Low: there is still some Phase-0/2 scaffolding that looks more like transitional code than settled product code

`src/discord/claude-sdk/claude-sdk-session-manager.ts:8` imports `SDKToolUseSummaryMessage` but never uses it. `src/discord/claude-transport.ts:19-25` defines `ClaudeSdkSessionLike` / `ClaudeSdkSessionManagerLike`, and nothing in the repository currently references them. `src/discord/claude-sdk/claude-sdk-handlers.ts:285-319` also duplicates the permission button rendering already implemented in `src/discord/handlers/permission.ts:46-80` instead of sharing one renderer.

None of these are release blockers, but they are the clearest YAGNI / dead-code signals in today's patch set.

## Open Questions / Assumptions

- I am assuming "Restore SDK Session" is intended to mean real Agent SDK resume semantics, not "start a fresh session in the old Discord thread."
- I am assuming explicit `/claude stop` for SDK should archive/remove persisted SDK mapping the same way Codex stop already does.
- I am assuming parent-channel command behavior should stay symmetrical between PTY Claude and SDK Claude once transport abstraction exists.

## Simplification Notes

- The transport layer itself is not overbuilt yet; the bigger issue is that the old PTY-centric lookups still leak through several command paths.
- The SDK handler is doing some nice-to-have work already, but the main simplification worth making now is to share permission-message construction with the PTY path instead of maintaining two nearly identical button renderers.
- I did not find evidence that the SDK manager is wildly over-engineered overall. Most of the complexity is justified by multi-turn input, permission promises, and Discord event bridging. The current problems are mostly lifecycle gaps, not too much abstraction.
