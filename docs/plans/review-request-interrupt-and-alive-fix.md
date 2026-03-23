# Review Request: isProcessAlive fix + Codex interrupt

## Commits
- `d7bb7fa` Fix isProcessAlive returning false for live processes on bot restart
- `63c0104` Interrupt Codex session together when Claude is interrupted

## Changes Summary

### 1. isProcessAlive EPERM bug fix (`process-manager.ts:309`)
- `process.kill(pid, 0)` throws EPERM when process exists but can't be signaled
- Old code: catch-all returned `false` (incorrectly marking alive process as dead)
- Fix: return `true` for EPERM, only `false` for ESRCH (no such process)

### 2. PID 0 health check skip (`process-manager.ts:447-460`)
- Terminal app spawns have PID 0 until session connects and reports real PID
- Old code: `isProcessAlive(0)` → `false` → marked as orphaned
- Fix: skip status decisions for PID 0 entries (60s timeout for `starting` state only)

### 3. PID 0 kill guard (`process-manager.ts:220-238`)
- Added guard in `kill()` method: `process.kill(0, signal)` would signal the entire process group
- If terminal window tracked, close it instead; otherwise return false

### 4. Reconciliation race condition fix (`cli/discord.ts`)
- Added 5s grace period after socket server starts, before reconciliation
- Re-runs health check after grace period for fresh status
- Checks `sessionManager.getSession()` before cleanup — revives if CLI reconnected
- Removed `markAsReconciling` pattern (was blocking reconnection during cleanup)

### 5. Codex interrupt (`codex-session-manager.ts:134-150`)
- New `interruptSession(sessionId)` method: aborts active turn without ending session
- `/interrupt` command and panel button now interrupt both Claude and Codex in same thread

## Questions for Review
1. Is the EPERM handling correct for Codex SDK's AbortController?
2. Any concern with the 5s grace period delay on startup?
3. Does `interruptSession` need to emit any event to notify the Discord thread?
