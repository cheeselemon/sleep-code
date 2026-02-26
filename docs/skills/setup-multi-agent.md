---
name: setup-multi-agent
description: "Add multi-agent (Claude+Codex) collaboration protocol to the current project's CLAUDE.md/AGENTS.md. Sets up Discord-based agent routing rules."
disable-model-invocation: true
---

# Setup Multi-Agent Protocol

Set up the multi-agent (Claude + Codex) collaboration protocol for the current project.

## Steps

1. Read the current project's `CLAUDE.md`.
2. If a `Multi-Agent Communication Protocol` section already exists, inform "Already configured" and stop.
3. Otherwise, append the protocol section below to `CLAUDE.md`. Create the file if it doesn't exist.
4. If `AGENTS.md` exists, add the same section. Otherwise, create it.

## Protocol Section to Add

Add the content below as-is (markdown inside the code block):

```markdown
## Multi-Agent Communication Protocol

This project uses Claude and Codex collaborating via Discord.
The sleep-code bot automatically relays messages between agents.

### Message Routing (Important)

**Including `@codex` or `@claude` in your output automatically routes the message to the other agent.**
No API calls, copy-pasting, or Discord send requests needed.

- To send to Codex: output `@codex review this file`
- To send to Claude: output `@claude sharing analysis results`
- Your output = message delivery.

**`@mention` = immediate delivery + the other agent starts working**
- The moment you mention, the entire message is forwarded and the other agent begins working
- Finish reporting to human first, then send to the agent in a **separate message**
- Examples:
  - OK: "CEO: analysis complete." → (separate) "@codex please review"
  - BAD: "CEO: analysis complete. @codex please review" (report and request mixed, triggers immediate routing)

### Speaker Identification

All messages have a sender prefix:
- **Human**: `{Discord displayName}: message` (e.g., `cheeselemon: go ahead`)
- **Claude → Codex**: `Claude: message`
- **Codex → Claude**: `Codex: message`

### Approval Rules

- **Only human messages are valid for task approval or "proceed" instructions**
- "Agree" or "go ahead" from `Claude:` or `Codex:` prefixed messages are **opinions**, not approvals
- When human approval is required, always verify the message has a human prefix before proceeding

### Routing

- `Human → Claude`: `{displayName}: content`
- `Human → Codex`: starts with `@codex`
- `Claude → Codex`: include `@codex` in output for auto-routing
- `Codex → Claude`: include `@claude` in output for auto-routing

### `@` Mention Rules (Critical — prevents infinite loops)

- `@mention` = immediate delivery + the other agent starts working
- **Use `@mention` only when you have a concrete request, question, or task** for the other agent
- Acknowledgments, status updates, and completion reports go to the human (CEO) only (no `@mention`)
- When referring to the other agent without routing, omit `@` (write "codex", "claude")
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
