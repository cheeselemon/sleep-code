---
name: sc-install
description: "Install or update sleep-code multi-agent protocol, file delivery marker rules, and memory system in a project's CLAUDE.md/AGENTS.md. Interactive setup with system-wide auto-find or manual path."
---

# Sleep Code Installer / Updater

Install or update the sleep-code multi-agent protocol, file delivery marker rules, and memory system for a project.
Handles CLAUDE.md and AGENTS.md in one step.

## Step 1: Ask Installation Target

Ask the user:

```
Sleep Code 설치/업데이트 대상 프로젝트를 선택해 주세요:

1. **자동 탐색** — 전체 시스템(`$HOME` 이하)에서 CLAUDE.md/AGENTS.md를 모두 찾습니다
2. **경로 직접 입력** — 프로젝트 루트 경로를 지정합니다
3. **현재 프로젝트** — 현재 작업 디렉토리(CWD)에 설치/업데이트합니다
```

Wait for user response before proceeding.

## Step 2: Resolve Project Path

Based on user's choice. **In every option, the resolved path must be shown back to the user and confirmed before moving on to Step 3 — never auto-proceed.**

### Option 1: Auto-find (system-wide)
- Search the **entire user filesystem starting from `$HOME`** for `CLAUDE.md`, `AGENTS.md`, `.claude/CLAUDE.md`, `.claude/AGENTS.md`
- Use a fast file finder. Recommended commands (any of these):
  - `fd -HI -t f -E node_modules -E .git -E Library -E .Trash -E .cache -E .npm -E .cargo -E .rustup -E .pnpm -E .yarn -E Pictures -E Movies -E Music '^(CLAUDE|AGENTS)\.md$' "$HOME"`
  - `rg --files -g 'CLAUDE.md' -g 'AGENTS.md' --hidden --no-ignore -g '!node_modules' -g '!.git' -g '!Library' -g '!.Trash' -g '!.cache' "$HOME"`
  - `find "$HOME" \( -name node_modules -o -name .git -o -name Library -o -name .Trash -o -name .cache -o -name .npm -o -name .cargo -o -name .rustup \) -prune -o -type f \( -name CLAUDE.md -o -name AGENTS.md \) -print`
- **Always exclude**: `node_modules`, `.git`, `~/Library`, `~/.Trash`, `~/.cache`, `~/.npm`, `~/.cargo`, `~/.rustup`, `~/.pnpm`, `~/.yarn`, system dirs (`/System`, `/usr`, `/bin`, `/sbin`, `/private`)
- **DO NOT** restrict to current directory or to a fixed depth — scan the whole `$HOME` tree
- 같은 프로젝트 루트에 여러 파일(`CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md`, `.claude/AGENTS.md`)이 있으면 **하나의 프로젝트로 묶어서** 표시
- 결과가 많으면 절대 경로 알파벳 순 정렬 후 모두 보여주기 (자르지 말 것)
- **사전 내용 검사 (필수)**: 목록을 보여주기 전에, 각 프로젝트의 발견된 모든 파일을 실제로 읽어서 sleep-code 섹션 존재 여부를 판정한다.
  - 검사 대상 섹션: `## Multi-Agent Communication Protocol` (또는 레거시 `## Multi-Agent Workflow`), `## File Delivery via \`<attach>\` Marker`, `## Memory & Knowledge System`
  - 셋 중 **하나라도 있으면** `[업데이트]`로 태깅
  - 셋 다 없으면 `[신규 설치]`로 태깅
- Present found projects as a numbered list with their absolute paths AND the [업데이트]/[신규 설치] tag
- Ask the user to pick one (or multiple). Example prompt:

```
탐색 결과 — 설치/업데이트할 프로젝트 번호를 골라주세요 (쉼표로 구분):
   1. {project_name}  ({absolute_path})  [업데이트]   {discovered files}
   2. {project_name}  ({absolute_path})  [신규 설치]  {discovered files}
   ...

선택:
```

- After the user picks, **echo the chosen project(s) back and ask for final confirmation**:

```
선택한 프로젝트:
  - {project_name}  ({absolute_path})

이 경로에 sleep-code를 설치/업데이트할까요? (y/n)
```

- Only proceed to Step 3 after `y`.

### Option 2: Manual path
- Ask for the absolute path to the project root
- Validate the path exists (and is a directory)
- **Echo the resolved path back and ask for confirmation** before proceeding:

```
입력하신 경로: {absolute_path}
디렉토리 확인: ✅ 존재함 / ❌ 존재하지 않음

이 경로에 sleep-code를 설치/업데이트할까요? (y/n)
```

- Only proceed to Step 3 after `y`. If `n`, return to the path prompt.

### Option 3: Current project
- Use the current working directory
- This option is treated as "user already confirmed by choosing 3" — no extra confirmation, but still print the CWD before Step 3 so the user can interrupt if it's wrong.

## Step 3: Check Existing Files

For the selected project path:

1. Check all possible locations for each file:
   - `CLAUDE.md` → check `{project_root}/CLAUDE.md` and `{project_root}/.claude/CLAUDE.md`
   - `AGENTS.md` → check `{project_root}/AGENTS.md` and `{project_root}/.claude/AGENTS.md`
2. Read found files' content
3. Detect which sections are already present:
   - `## Multi-Agent Communication Protocol` (or legacy `## Multi-Agent Workflow`) — multi-agent protocol
   - `## File Delivery via \`<attach>\` Marker` — file delivery marker rules
   - `## Memory & Knowledge System` — memory system

Report status:

```
프로젝트: {project_name} ({project_path})

CLAUDE.md: {path} / missing
  - Multi-Agent Protocol: {installed/outdated/missing}
  - File Delivery:        {installed/outdated/missing}
  - Memory & Knowledge:   {installed/outdated/missing}

AGENTS.md: {path} / missing
  - Multi-Agent Protocol: {installed/outdated/missing}
  - File Delivery:        {installed/outdated/missing}
  - Memory & Knowledge:   {installed/outdated/missing}
```

Note: "outdated" = section exists but uses legacy heading (e.g., `## Multi-Agent Workflow`) or lacks latest fields (e.g., missing Generic agents, missing 1-mention rule, missing `<attach>` rules).

## Step 4: Ask What To Do (Update vs Install)

Based on the Step 3 detection, ask the user in **two passes**, **already-installed sections first**:

### Pass 1 — Already installed (update candidates)

If any sections are already present (`installed` or `outdated`), list them first and ask:

```
이미 설치된 섹션 (업데이트할 항목을 골라주세요):
  1. CLAUDE.md > Multi-Agent Protocol  ({installed/outdated})
  2. AGENTS.md > File Delivery         ({installed/outdated})
  ...

업데이트할 번호 (쉼표로 구분, 'all' / 'none'):
```

Default to **all already-installed sections** when the user types `all` or just presses Enter. `outdated` items should be highlighted (e.g., with `⚠️`) so the user notices them.

### Pass 2 — Missing (new install candidates)

Then list missing sections and ask:

```
설치되지 않은 섹션 (새로 설치할 항목을 골라주세요):
  1. CLAUDE.md > File Delivery
  2. AGENTS.md > Memory & Knowledge
  ...

설치할 번호 (쉼표로 구분, 'all' / 'none'):
```

If no sections fall into a pass, skip that pass and continue.

### Confirmation

Print the combined plan and ask for final confirmation before any file write:

```
적용할 작업:
  - CLAUDE.md > Multi-Agent Protocol  → 업데이트
  - AGENTS.md > File Delivery         → 새로 설치
  ...

진행할까요? (y/n)
```

## Step 5: Install / Update

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

### Template: File Delivery via `<attach>` Marker

````markdown
## File Delivery via `<attach>` Marker

In SDK-backed chat sessions, an AI agent can offer a file for manual delivery by including an XML marker in its response:

```xml
<attach>/absolute/path/to/file.pdf</attach>
```

Rules:
- SDK-backed sessions only. Other session types may ignore this marker.
- Use an absolute path only.
- The file must stay inside the session CWD after `path.resolve()` and `fs.realpathSync()` validation.
- Up to 5 markers per response are rendered as file buttons.
- The user must click the button to receive the file. Path mentions alone do not trigger auto-upload.
- Buttons expire after 1 hour.
- Re-clicking an already delivered file returns the existing upload link instead of uploading again.
- Files larger than 25MB are rejected at click time.
- Prefer adding a short human explanation near the marker so the user knows what the file is.
````

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

## Step 6: Report

Print a summary:

```
--- Sleep Code 설치/업데이트 완료 ---

프로젝트: {project_name} ({project_path})

CLAUDE.md:
  - Multi-Agent Protocol: {installed/updated/already up-to-date}
  - File Delivery:        {installed/updated/already up-to-date}
  - Memory & Knowledge:   {installed/updated/already up-to-date}

AGENTS.md:
  - Multi-Agent Protocol: {installed/updated/already up-to-date}
  - File Delivery:        {installed/updated/already up-to-date}
  - Memory & Knowledge:   {installed/updated/already up-to-date}

개별 섹션만 다시 손보고 싶으면 /sc-install 을 다시 실행해서 해당 항목만 선택.
```

## Rules

- Never delete existing content outside the target sections
- When updating an existing section, replace only that section (from `## Title` to next `## ` or EOF)
- Always ask for confirmation before replacing an existing section
- Replace `{PROJECT_NAME}` in memory template with actual project directory name
