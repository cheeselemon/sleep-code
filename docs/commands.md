# Commands Reference

## Discord Commands

### Session Management

| Command | Description |
|---------|-------------|
| `/claude start` | Start a new Claude session via PTY (select directory) |
| `/claude start-sdk` | Start a new Claude session via Agent SDK (select model & context → directory) |
| `/claude stop` | Stop a running session (PTY or SDK) |
| `/claude status` | Show all managed sessions (🔧 PTY / 📡 SDK) |
| `/claude restore` | Restore a dead session in the current thread (resumes conversation history) |
| `/sessions` | List active sessions |

> **PTY vs SDK**: PTY supports terminal controls (`/background`, `/mode`, `/compact`), while SDK receives structured tool call/result directly. See [SDK Session Guide](sdk-session.md) for a detailed comparison.
>
> **Model selection:** `/claude start-sdk` first asks for model + context window, then directory. See [Model Selection](sdk-session.md#model-selection).

### In-Session Controls

| Command | PTY | SDK | Description |
|---------|:---:|:---:|-------------|
| `/interrupt` | ✅ | ✅ | Interrupt Claude (PTY: Escape, SDK: abort current turn) |
| `/background` | ✅ | ❌ | Send to background mode (Ctrl+B) |
| `/mode` | ✅ | ❌ | Toggle plan/execute mode (Shift+Tab) |
| `/compact` | ✅ | ❌ | Compact the conversation |
| `/model <name>` | ✅ | ⚠️ | Switch model (opus, sonnet, haiku). SDK: applies from next turn |
| `/panel` | ✅ | ✅ | Show control panel with buttons |
| `/yolo-sleep` | ✅ | ✅ | Toggle YOLO mode (auto-approve all) |

### Settings

| Command | Description |
|---------|-------------|
| `/claude add-dir <path>` | Add directory to whitelist |
| `/claude remove-dir` | Remove directory from whitelist |
| `/claude list-dirs` | List whitelisted directories |
| `/claude set-terminal` | Set terminal app (Terminal.app, iTerm2, or background) |

### Codex (OpenAI)

| Command | Description |
|---------|-------------|
| `/codex start` | Start a new Codex session (select **model + reasoning effort → directory**) |
| `/codex stop` | Stop a running Codex session |
| `/codex status` | Show all Codex sessions |
| `/codex intelligence` | Change reasoning effort of the Codex session in this thread on the fly (no context loss) |

**Available Codex models** (selected at `/codex start`):

| Model | Reasoning Efforts | Notes |
|-------|-------------------|-------|
| `gpt-5.5` | minimal / low / medium / high / xhigh | Frontier · default model · `xhigh` = deepest reasoning, slowest |
| `gpt-5.4` | high / medium | Previous generation |
| `gpt-5.4-mini` | medium | Smaller · faster · cheaper |
| `gpt-5.3-codex` | high | Coding-specialized variant |
| `gpt-5.2` | medium | Legacy |

> **Note:** `/codex intelligence` aborts the current turn and resumes the thread with the new effort. Conversation context is preserved via `codexThreadId`. Sandbox mode (read-only ↔ workspace-write toggled by `/yolo-sleep`) is also kept.

**User input behavior:** Messages sent while Codex is mid-turn are queued (cap 10) and auto-merged into a single follow-up turn when the active turn ends. No more `session busy` errors on rapid multi-message input.

### Generic Agents (OpenRouter / DeepInfra)

| Command | Description |
|---------|-------------|
| `/chat start` | Start a new agent session (select model → directory) |
| `/chat stop` | Stop current thread's agent session |
| `/chat status` | Show all active agent sessions |
| `/chat models` | Show available models with pricing |

**Available Models:**

| Alias | Model | Context | Pricing (in/out per 1M) |
|-------|-------|---------|------------------------|
| `gemma4` | Gemma 4 27B | 131K | $0.08 / $0.35 |
| `glm5` | GLM-5 | 131K | $0.72 / $2.30 |
| `glm51` | GLM-5.1 | 131K | $0.95 / $3.15 |
| `qwen3-coder` | Qwen3 Coder | 262K | Free tier |

### Generic Agent Setup

1. Get an API key from [OpenRouter](https://openrouter.ai) or [DeepInfra](https://deepinfra.com).
2. Add to `~/.sleep-code/discord.env`:

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxxx
# Optional: DEEPINFRA_API_KEY=xxxxx
```

3. Restart the bot:

```bash
pm2 restart sleep-discord
```

4. Verify:

```bash
pm2 logs sleep-discord --lines 5 --nostream
# Expected: {"level":"info","msg":"AgentSessionManager initialized"}
```

> **Note:** Generic agents share the same tool set (Bash, Read, Write, Edit, Grep, Glob) with CWD-based path restriction and deny rules from `~/.claude/settings.json`.

### Memory

| Command | Description |
|---------|-------------|
| `/memory opt-out` | Disable memory collection for this session |
| `/memory opt-out --global` | Pause entire memory system |
| `/memory opt-in` | Re-enable memory for this session |
| `/memory opt-in --global` | Resume entire memory system |
| `/memory status` | Show memory system status (global state, queue, model, config) |
| `/memory digest` | Generate a daily digest now and post to #sleep-code-memory |
| `/memory consolidate` | Run memory consolidation now (merge duplicates + clean noise) |

### Other

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/status` | Show current thread session status |
| `/commands` | List all registered slash commands |
| `/settings` | Show current bot and memory configuration |

## All Platform Commands

| Command | Slack | Discord | Telegram | Description |
|---------|:-----:|:-------:|:--------:|-------------|
| `/sessions` | O | O | O | List active sessions |
| `/switch <name>` | - | - | O | Switch session (Telegram only) |
| `/model <name>` | O | O | O | Switch model |
| `/compact` | O | O | O | Compact conversation |
| `/background` | O | O | O | Background mode (Ctrl+B) |
| `/interrupt` | O | O | O | Interrupt (Escape) |
| `/mode` | O | O | O | Toggle mode (Shift+Tab) |

## Multi-Agent Message Routing (Discord)

When multiple agents are in the same thread, use `@mention` or prefixes to route messages:

| Prefix | Target | Example |
|--------|--------|---------|
| `@claude` | Claude | `@claude explain this code` |
| `@codex` or `x:` | Codex | `@codex run the tests` |
| `@gemma4` | Gemma 4 | `@gemma4 what do you think?` |
| `@glm5` / `@glm51` | GLM-5 / 5.1 | `@glm5 review this` |
| `@qwen3-coder` | Qwen3 Coder | `@qwen3-coder optimize this` |
| `c:` or `claude:` | Claude | `c: explain this code` |
| (none) | Last active agent | `fix the bug` |

> **Note:** Agent aliases are auto-detected from the model registry. New models added to `model-registry.ts` are automatically routable.

## Memory CLI

```bash
sleep-code memory search <query> [--project <name>]          # Hybrid search (vector + keyword)
sleep-code memory store <text> [--project <name>] [--kind <kind>]  # Manual store
sleep-code memory delete <id>                                 # Delete by ID
sleep-code memory supersede <oldId> <newId>                   # Manually mark old as superseded
sleep-code memory unsupersede <id>                            # Undo supersede, restore to open
sleep-code memory stats <project>                             # Count memories
sleep-code memory consolidate [--project <name>] [--dry-run]  # Merge duplicates, clean noise
sleep-code memory retag [--project <name>] [--dry-run]        # Re-classify topicKeys via LLM
sleep-code memory graph [--project <name>] [--threshold 0.7]  # Open memory graph in browser
sleep-code memory distill-test                                # Test distill with sample messages
sleep-code memory migrate-tasks [--dry-run]                   # One-time LLM review of open tasks with git log
```
