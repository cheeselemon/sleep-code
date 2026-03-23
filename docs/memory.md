# Memory System

Sleep Code's semantic memory pipeline automatically remembers important conversations — decisions, facts, preferences, task assignments — using a local vector database.

**Requirements:** [Ollama](https://ollama.com/) running locally. Without it, the bot works normally without memory features.

## Pipeline Overview

```
Message → Collect → Batch Distill → Dedup → Store → Recall
                        ↓
                 Supersede detection
```

1. **Collect** — Sliding context window per channel (default 15 messages)
2. **Batch Distill** — Claude SDK (haiku) classifies messages in batches: store or skip. Only decisions, facts, preferences, tasks, and feedback survive
3. **Validate** — Rejects vague meta-descriptions (e.g., "User requested something"). Requires concrete signals: dates, numbers, file names, code tokens
4. **Dedup** — Two-layer duplicate prevention:
   - Exact text match (pre-embedding, cheap)
   - Vector similarity ≥ 0.90 (catches paraphrases)
5. **Supersede** — When corrections are detected (time changes, name corrections, price updates), finds the old memory and marks it `superseded`. Uses multi-signal scoring: vector similarity, topic match, anchor term overlap, kind compatibility
6. **Embed** — Ollama (`qwen3-embedding:4b`) generates 2560-dim vectors
7. **Store** — Vectors + metadata saved to LanceDB (`~/.sleep-code/memory/lancedb`)
8. **Recall** — Hybrid search blending vector similarity + keyword overlap

## Batch Distill

Replaces per-message Ollama distill with batched Claude SDK processing:

- **Persistent SDK session** — system prompt cached across turns for efficiency
- **Hybrid trigger** — processes when queue hits 20 messages OR every 30 minutes
- **Session refresh** — SDK session recycled every 2 hours to keep context fresh
- **Brain-science prompt** — based on Peak-End Rule, Fuzzy-Trace Theory, and Semanticization research

### The "6-Month Test"

Before storing, the classifier asks: *"Will this information matter in 6 months?"*

| STORE | SKIP |
|-------|------|
| Decisions with substance | Process narration ("checking...", "done") |
| Discovered facts / lessons learned | Meta-descriptions without content |
| Architecture / design rules | Routine confirmations |
| Preferences / constraints | Intermediate deliberation |
| Commitments / ownership | Completed one-off tasks |
| Corrections / updates | Agent status updates |
| Surprising failures | Emotional reactions without knowledge |

## Daily Digest

Scheduled briefings summarizing your open tasks and recent decisions.

- **Default schedule:** 10:00, 16:00 (configurable timezone and times)
- **Model:** Claude SDK sonnet (configurable)
- **Content:** Open tasks (all projects) + recent decisions (24h) + active topics
- **Custom prompt:** Place `~/.sleep-code/digest-prompt.txt` to override the default template

Template variables: `{{OPEN_TASKS}}`, `{{RECENT_DECISIONS}}`, `{{ACTIVE_TOPICS}}`, `{{TASK_COUNT}}`, `{{DECISION_COUNT}}`

## Consolidation

Periodic cleanup that merges near-duplicates and removes noise. Runs every 24 hours automatically.

1. **TopicKey merge** — Same topic + kind, within 7 days, cosine ≥ 0.85 → merge
2. **Vector merge** — Any topic, cosine ≥ 0.93 → merge
3. **Cleanup** — Remove low-priority observations, agent noise, language errors

Results posted to `#sleep-code-memory` weekly consolidation thread.

## Discord Integration

On bot startup, a `#sleep-code-memory` channel is auto-created with:

- **Daily threads** (`distill-YYYY-MM-DD`) — batch results with stored/superseded/skipped counts
- **Weekly threads** (`consolidation-YYYY-Www`) — consolidation reports
- **Digest posts** — daily briefings in the channel

### `/memory` Command

| Command | Effect |
|---------|--------|
| `/memory opt-out` | Stop memory collection for this session |
| `/memory opt-out --global` | Pause entire memory system |
| `/memory opt-in` | Resume collection for this session |
| `/memory opt-in --global` | Resume entire memory system |
| `/memory status` | Show current memory collection status |

## Memory CLI

```bash
sleep-code memory search <query> [--project <name>]
sleep-code memory store <text> [--project <name>] [--kind <kind>]
sleep-code memory delete <id>
sleep-code memory supersede <oldId> <newId>
sleep-code memory unsupersede <id>
sleep-code memory stats <project>
sleep-code memory consolidate [--project <name>] [--dry-run]
sleep-code memory retag [--project <name>] [--dry-run]
sleep-code memory graph [--project <name>] [--threshold 0.7]
sleep-code memory distill-test
```

## MCP Server

The memory store is exposed as an [MCP](https://modelcontextprotocol.io/) server (HTTP transport), accessible from any Claude Code session.

```bash
npm run memory-server                                    # direct
pm2 start ecosystem.config.cjs --only sleep-memory-mcp   # background
```

**Auto-connect** — add `.mcp.json` to your project root:

```json
{
  "mcpServers": {
    "sleep-code-memory": {
      "type": "http",
      "url": "http://127.0.0.1:24242/mcp"
    }
  }
}
```

**MCP Tools:** `sc_memory_search`, `sc_memory_list`, `sc_memory_store`, `sc_memory_update`, `sc_memory_supersede`, `sc_memory_delete`

## Memory Explorer

Web UI for browsing and visualizing the memory graph:

```bash
npm run explorer   # http://localhost:3333
```

## Configuration

All memory settings in `~/.sleep-code/memory-config.json` (hot-reloaded on change):

```json
{
  "distill": {
    "enabled": true,
    "model": "haiku",
    "batchMaxMessages": 20,
    "batchIntervalMs": 1800000,
    "sessionRefreshMs": 7200000,
    "skipVerbosity": "count",
    "excludeProjects": [],
    "excludeChannels": []
  },
  "consolidation": {
    "enabled": true,
    "intervalMs": 86400000
  },
  "digest": {
    "enabled": true,
    "schedule": ["10:00", "16:00"],
    "timezone": "Asia/Seoul",
    "model": "sonnet"
  }
}
```

## Disabling Memory

```bash
DISABLE_MEMORY=1 npm run discord   # environment variable
# or simply don't run Ollama — memory auto-disables
```

## Requirements

- [Ollama](https://ollama.com/) with:
  - `qwen3-embedding:4b` — embedding model
- Memory data: `~/.sleep-code/memory/lancedb`
