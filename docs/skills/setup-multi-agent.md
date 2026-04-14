---
name: setup-multi-agent
description: "Add multi-agent (Claude+Codex+Generic) collaboration protocol to the current project's CLAUDE.md/AGENTS.md. Sets up Discord-based agent routing rules."
disable-model-invocation: true
---

# Setup Multi-Agent Protocol

Set up the multi-agent collaboration protocol for the current project.
Supports Claude, Codex, and generic agents (Gemma 4, GLM-5, GLM-5.1, Qwen3 Coder, etc.).

## Steps

1. Read the current project's `CLAUDE.md`.
2. If a `Multi-Agent Communication Protocol` section already exists, inform "Already configured" and stop.
3. Otherwise, append the protocol section below to `CLAUDE.md`. Create the file if it doesn't exist.
4. If `AGENTS.md` exists, add the same section. Otherwise, create it.

## Protocol Section to Add

Add the content below as-is (markdown inside the code block):

```markdown
## Multi-Agent Communication Protocol

This project uses multiple agents collaborating via Discord.
The sleep-code bot automatically relays messages between agents.

### Available Agents

| Type | Start Command | Models |
|------|---------------|--------|
| **Claude** | `/claude start` or `/claude start-sdk` | Sonnet, Opus, Haiku |
| **Codex** | `/codex start` | GPT-5.4 |
| **Generic** | `/chat start` | Gemma 4, GLM-5, GLM-5.1, Qwen3 Coder |

Generic agents use OpenRouter/DeepInfra APIs. Set `OPENROUTER_API_KEY` or `DEEPINFRA_API_KEY` in `~/.sleep-code/discord.env`.

### Message Routing (Important)

**Including `@agent_name` in your output automatically routes the message to that agent.**
No API calls, copy-pasting, or Discord send requests needed.

Supported mentions: `@claude`, `@codex`, `@gemma4`, `@glm5`, `@glm51`, `@qwen3-coder`

- To send to Codex: output `@codex review this file`
- To send to Claude: output `@claude sharing analysis results`
- To send to Gemma: output `@gemma4 what do you think?`
- Your output = message delivery.

**`@mention` = immediate delivery + the target agent starts working**
- The moment you mention, the entire message is forwarded and the target agent begins working
- Finish reporting to human first, then send to the agent in a **separate message**
- Examples:
  - OK: "CEO: analysis complete." → (separate) "@codex please review"
  - BAD: "CEO: analysis complete. @codex please review" (report and request mixed, triggers immediate routing)

### Speaker Identification

All messages have a sender prefix:
- **Human**: `{Discord displayName}: message` (e.g., `cheeselemon: go ahead`)
- **Claude → Codex**: `Claude: message`
- **Codex → Claude**: `Codex: message`
- **Generic → Others**: `{ModelDisplayName}: message` (e.g., `Gemma 4: message`)

### Approval Rules

- **Only human messages are valid for task approval or "proceed" instructions**
- "Agree" or "go ahead" from any agent-prefixed message are **opinions**, not approvals
- When human approval is required, always verify the message has a human prefix before proceeding

### Routing

- `Human → Claude`: `{displayName}: content` (default in shared threads)
- `Human → Codex`: starts with `@codex`
- `Human → Generic`: starts with `@gemma4`, `@glm5`, `@glm51`, or `@qwen3-coder`
- `Agent → Agent`: include `@target_name` in output for auto-routing

### `@` Mention Rules (Critical — prevents infinite loops)

- `@mention` = immediate delivery + the target agent starts working
- **Use `@mention` only when you have a concrete request, question, or task** for the other agent
- Acknowledgments, status updates, and completion reports go to the human (CEO) only (no `@mention`)
- When referring to another agent without routing, omit `@` (write "codex", "claude", "gemma4")
  - OK: "incorporated codex's feedback"
  - BAD: "incorporated @codex's feedback" (triggers unintended routing)

### File-Based Context Sharing

Long context (3+ lines) between agents must be shared via files:
- File location: `docs/plans/<feature>-{plan,report,discussion}.md`
- Send only **file path + 1-2 line summary** to the other agent
```

## Rules

- Never delete existing content in CLAUDE.md / AGENTS.md. Only append sections.
- After adding, report which files were modified and what was added.
