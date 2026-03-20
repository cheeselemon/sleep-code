# Commands Reference

## Discord Commands

### Session Management

| Command | Description |
|---------|-------------|
| `/claude start` | Start a new Claude session via PTY (select directory) |
| `/claude start-sdk` | Start a new Claude session via Agent SDK (select directory) |
| `/claude stop` | Stop a running session (PTY or SDK) |
| `/claude status` | Show all managed sessions (🔧 PTY / 📡 SDK) |
| `/claude restore` | Restore a dead session in the current thread (resumes conversation history) |
| `/sessions` | List active sessions |

> **PTY vs SDK**: PTY는 터미널 제어(`/background`, `/mode`, `/compact`)를 지원하고, SDK는 구조화된 tool call/result을 직접 수신합니다. 자세한 비교는 [SDK Session Guide](sdk-session.md)를 참고하세요.

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
| `/codex start` | Start a new Codex session (select directory) |
| `/codex stop` | Stop a running Codex session |
| `/codex status` | Show all Codex sessions |

### Other

| Command | Description |
|---------|-------------|
| `/help` | Show all available commands |
| `/status` | Show current thread session status |

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

When both Claude and Codex are in the same thread, use prefixes to route messages:

| Prefix | Target | Example |
|--------|--------|---------|
| `c:` or `claude:` | Claude | `c: explain this code` |
| `x:` or `codex:` | Codex | `x: run the tests` |
| (none) | Last active agent | `fix the bug` |

Using `x:` in a Claude-only thread will auto-create a Codex session in the same directory.

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
```
