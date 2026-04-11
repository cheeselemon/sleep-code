# Task: Memory Authority Step 7 & 8

## Context
We're migrating all LanceDB writes to go through a single MCP server (Memory Authority).
Steps 0–6 are done. Steps 7 & 8 remain.

## Step 7: CLI write → MemoryAuthorityClient

**File**: `src/cli/memory.ts`

**What to change**:
- Replace `createServices()` (which creates a direct `MemoryService`) with `MemoryAuthorityClient` from `src/memory/memory-authority-client.ts`
- All write operations (store, delete, supersede, unsupersede, consolidate, retag) should go through the client's HTTP methods
- Read operations (search, list, graph, stats) can also go through the client for consistency
- The MCP server must be running for CLI writes to work — add a health check or clear error message if the server is unreachable

**Reference**: Look at how `src/memory/memory-collector.ts` and `src/memory/batch-distill-runner.ts` use `IMemoryStore` interface.

## Step 8: Remove MemoryService from bot

**Files to modify**:
1. `src/cli/discord.ts` — remove `MemoryService` initialization block, pass `memoryClient` instead
2. `src/discord/discord-app.ts` — update `DiscordAppOptions` to accept `memoryClient` (MemoryAuthorityClient) instead of `memoryService` (MemoryService)
3. Update `CommandContext` and `InteractionContext` types if they reference `memoryService`
4. Any command/handler that uses `memoryService` directly should use `memoryClient`

**Important**:
- Do NOT touch `src/mcp/memory-server.ts` — that's the only place that should still use `MemoryService` directly
- Do NOT restart the Discord bot server
- Run `npm run build` after changes to verify compilation

## Acceptance Criteria
- `npm run build` succeeds with no errors
- CLI memory commands use MemoryAuthorityClient
- Discord bot uses MemoryAuthorityClient, not MemoryService directly
- Only `memory-server.ts` retains direct MemoryService usage
