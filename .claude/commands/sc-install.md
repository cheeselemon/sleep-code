---
name: sc-install
description: "Install sleep-code multi-agent protocol and memory system to a project's CLAUDE.md/AGENTS.md. Interactive setup with auto-find or manual path."
---

# Sleep Code Installer

Set up the sleep-code multi-agent protocol and memory system for a project.
Handles CLAUDE.md, AGENTS.md, and skill file installation in one step.

## Step 1: Ask Installation Target

Ask the user:

```
Sleep Code 설치 대상 프로젝트를 선택해 주세요:

1. **자동 탐색** — 현재 디렉토리 및 하위에서 CLAUDE.md/AGENTS.md를 찾습니다
2. **경로 직접 입력** — 프로젝트 루트 경로를 지정합니다
3. **현재 프로젝트** — 현재 작업 디렉토리(CWD)에 설치합니다
```

Wait for user response before proceeding.

## Step 2: Resolve Project Path

Based on user's choice:

### Option 1: Auto-find
- Search for `CLAUDE.md` files in the current directory and up to 3 levels deep
- Also check common locations: `~/Documents/GitHub/`, `~/projects/`, `~/dev/`
- **탐색 위치**: 프로젝트 루트의 `CLAUDE.md` 뿐 아니라 `.claude/CLAUDE.md`, `AGENTS.md`, `.claude/AGENTS.md`도 함께 탐색
- 같은 프로젝트 루트에 여러 파일이 있으면 하나의 프로젝트로 묶어서 표시
- Present found projects as a numbered list
- Let the user pick one (or multiple)

### Option 2: Manual path
- Ask for the absolute path to the project root
- Validate the path exists

### Option 3: Current project
- Use the current working directory

## Step 3: Check Existing Files

For the selected project path:

1. Check all possible locations for each file:
   - `CLAUDE.md` → check `{project_root}/CLAUDE.md` and `{project_root}/.claude/CLAUDE.md`
   - `AGENTS.md` → check `{project_root}/AGENTS.md` and `{project_root}/.claude/AGENTS.md`
2. Read found files' content
3. Detect which sections are already present:
   - `## Multi-Agent Communication Protocol` (or legacy `## Multi-Agent Workflow`) — multi-agent protocol
   - `## Memory & Knowledge System` — memory system

Report status:

```
프로젝트: {project_name} ({project_path})

CLAUDE.md: {path} / missing
  - Multi-Agent Protocol: {installed/outdated/missing}
  - Memory & Knowledge:   {installed/outdated/missing}

AGENTS.md: {path} / missing
  - Multi-Agent Protocol: {installed/outdated/missing}
  - Memory & Knowledge:   {installed/outdated/missing}
```

Note: "outdated" = section exists but uses legacy heading (e.g., `## Multi-Agent Workflow`) or lacks latest fields (e.g., missing Generic agents, missing 1-mention rule).

Ask user which sections to install/update. If a section already exists, offer to **replace** it with the latest template (user must confirm).

## Step 4: Install / Update

### If file is missing
Create `CLAUDE.md` and/or `AGENTS.md` with the selected sections.

For new `CLAUDE.md`, start with:
```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```

For new `AGENTS.md`, start with:
```markdown
# AGENTS.md
```

### If file exists — add missing section
Append the section at the end, before any trailing content that looks like a footer.

### If file exists — update existing section
Replace the old section (from `## Section Title` to the next `## ` heading or end of file) with the latest template.

### Template: Multi-Agent Communication Protocol

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
- **한 메시지에 `@mention`은 반드시 1개만 사용** — 여러 에이전트에게 보내려면 각각 별도 메시지로 전송
  - OK: "@codex review this" → (별도 메시지) "@gemma4 what do you think?"
  - BAD: "@codex review this and @gemma4 check that" (동시 전달로 혼선 발생)
- Acknowledgments, status updates, and completion reports go to the human (CEO) only (no `@mention`)
- When referring to another agent without routing, omit `@` (write "codex", "claude", "gemma4")
  - OK: "incorporated codex's feedback"
  - BAD: "incorporated @codex's feedback" (triggers unintended routing)

### File-Based Context Sharing

Long context (3+ lines) between agents must be shared via files:
- File location: `docs/plans/<feature>-{plan,report,discussion}.md`
- Send only **file path + 1-2 line summary** to the other agent
```

### Template: Memory & Knowledge System

Replace `{PROJECT_NAME}` with the last directory component of the project path (e.g., `/Users/foo/projects/my-app` → `my-app`).

```markdown
## Memory & Knowledge System

Conversations in this project are automatically remembered by the sleep-code memory pipeline.

### How It Works
1. Discord/terminal conversations are collected in real-time
2. A local LLM (Ollama qwen2.5:7b) classifies each message — distills it if worth remembering
3. Stored in LanceDB with vector embeddings (separated by project)
4. Duplicate memories are auto-merged (cosine similarity >= 0.85)

### What Gets Stored
- **decision**: Key decisions (e.g., "Refund penalty waived within 30 days of contract date")
- **fact**: Confirmed facts (e.g., "Not using API SDK due to cost")
- **preference**: Preferences/policies (e.g., "Use only Ollama local models")
- **task**: Assigned tasks
- **proposal**: Proposals and suggestions
- **feedback**: User feedback

Each memory is tagged with project, speaker, priority (0-10), and topicKey.

### Usage (MCP Tools)
- `sc_memory_search` — Semantic search. Returns relevant memories for queries like "what did we decide about refund logic?"
- `sc_memory_list` — List recent memories for the project
- `sc_memory_store` — Only use when the user explicitly requests it (e.g., "remember this", "store this")

### Project Settings
- project name: `{PROJECT_NAME}`
- Search example: `sc_memory_search(query="...", project="{PROJECT_NAME}")`
```

## Step 5: Install Skill Files

After project setup, also install the slash command skills to `~/.claude/commands/`:

- `docs/skills/setup-multi-agent.md` → `~/.claude/commands/sc-setup-multi-agent.md`
- `docs/skills/setup-memory-knowledge.md` ��� `~/.claude/commands/sc-setup-memory-knowledge.md`

The sleep-code repo is at: `/Users/cheeselemon/Documents/GitHub/cheeselemon/sleep-code`

Read each source file and write it to the destination. Do NOT modify the content.

## Step 6: Report

Print a summary:

```
--- Sleep Code 설치 완료 ---

프로젝트: {project_name} ({project_path})

CLAUDE.md:
  - Multi-Agent Protocol: {installed/updated/already up-to-date}
  - Memory & Knowledge:   {installed/updated/already up-to-date}

AGENTS.md:
  - Multi-Agent Protocol: {installed/updated/already up-to-date}
  - Memory & Knowledge:   {installed/updated/already up-to-date}

스킬 파일:
  - ~/.claude/commands/sc-setup-multi-agent.md:      {installed/updated}
  - ~/.claude/commands/sc-setup-memory-knowledge.md: {installed/updated}

개별 업데이트가 필요할 때:
  /sc-setup-multi-agent        — Multi-Agent Protocol만 추가/업데이트
  /sc-setup-memory-knowledge   — Memory & Knowledge만 추가/업데이트
```

## Rules

- Never delete existing content outside the target sections
- When updating an existing section, replace only that section (from `## Title` to next `## ` or EOF)
- Always ask for confirmation before replacing an existing section
- Replace `{PROJECT_NAME}` in memory template with actual project directory name
