---
name: sc-setup-memory-knowledge
description: "Add memory & knowledge system documentation to the current project's CLAUDE.md and AGENTS.md. Explains how the automatic memory pipeline works and how to use recall tools."
disable-model-invocation: true
---

# Setup Memory & Knowledge System

Set up the memory & knowledge system documentation for the current project.

## Steps

1. Read the current project's `CLAUDE.md`.
2. If a `Memory & Knowledge System` section already exists, inform "Already configured" and stop.
3. Otherwise, append the section below to `CLAUDE.md`. Create the file if it doesn't exist.
4. If `AGENTS.md` exists, add the same section. Otherwise, create it.
5. Replace `{PROJECT_NAME}` with the last directory component of the current working directory (e.g., `/Users/foo/projects/my-app` → `my-app`).

## Section to Add

Add the content below as-is (markdown inside the code block), after replacing `{PROJECT_NAME}`:

```markdown
## Memory & Knowledge System

Conversations in this project are automatically remembered by the sleep-code memory pipeline.

### How It Works
1. Discord/terminal conversations are collected in real-time
2. A local LLM (Ollama qwen2.5:7b) classifies each message — distills it if worth remembering
3. Stored in LanceDB with vector embeddings (separated by project)
4. Duplicate memories are auto-merged (cosine similarity ≥ 0.85)

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

## Rules

- Never delete existing content in CLAUDE.md / AGENTS.md. Only append sections.
- After adding, report which files were modified and what was added.
