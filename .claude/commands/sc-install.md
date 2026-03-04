---
name: sc-install
description: "Install sleep-code skills (sc-setup-multi-agent, sc-setup-memory-knowledge) to user-level Claude Code commands (~/.claude/commands/)."
---

# Sleep Code Skills Installer

Install sleep-code slash commands to the user's global Claude Code commands directory.

## Input

The user may provide a project path. If not, use the current working directory.

## Steps

1. Copy the following skill files from the sleep-code repository to `~/.claude/commands/`:

   **Source files (in the sleep-code repo):**
   - `docs/skills/setup-multi-agent.md` → `~/.claude/commands/sc-setup-multi-agent.md`
   - `docs/skills/setup-memory-knowledge.md` → `~/.claude/commands/sc-setup-memory-knowledge.md`

   The sleep-code repo is at: `/Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code`

2. Read each source file and write it to the destination. Do NOT modify the content.

3. After installation, print:

```
✓ Installed sleep-code skills to ~/.claude/commands/

Available commands (use in any project):
  /sc-setup-multi-agent        — Add multi-agent (Claude+Codex) protocol to CLAUDE.md
  /sc-setup-memory-knowledge   — Add memory & knowledge system docs to CLAUDE.md

Usage:
  1. Open any project in Claude Code
  2. Run /sc-setup-memory-knowledge to enable memory recall for that project
  3. Run /sc-setup-multi-agent if using Claude+Codex collaboration
```
