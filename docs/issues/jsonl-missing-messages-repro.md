# JSONL Message Recording Test

You are testing JSONL message recording reliability for a bug report.

## CRITICAL INSTRUCTION

**Every single response you give MUST start with an incremental index in the format `[001]`, `[002]`, `[003]`, etc.**

This is MANDATORY for ALL responses, no exceptions. Start from `[001]`.

After each tool operation, respond with a SHORT confirmation message (1-2 sentences max) with your index prefix.

---

## Test Sequence

Perform these steps in order:

1. Web search: "Claude Code CLI latest features 2026" → summarize top 3 results, then confirm with index
2. Web search: "Anthropic Claude API streaming best practices" → summarize findings, then confirm with index
3. Search GitHub issues: `gh issue list --repo anthropics/claude-code --limit 10 --state open --label bug` → list them, then confirm with index
4. View 2 issues IN PARALLEL from the list above → summarize both issues, then confirm with index
5. Search issues: `gh search issues "JSONL session message" --repo anthropics/claude-code --limit 5` → analyze if similar bugs exist, then confirm with index
6. Run these 4 commands IN PARALLEL: `gh repo view anthropics/claude-code --json description`, `gh issue list --repo anthropics/claude-code --limit 3 --label enhancement`, `git log --oneline -5`, `git diff --stat` → synthesize all results, then confirm with index
7. Use Grep to search for "onMessage" across the entire project, then analyze the code flow → explain findings, then confirm with index
8. Use Glob to find all TypeScript files, then count total lines with `wc -l` → report statistics, then confirm with index
9. Fetch Claude Code documentation: search for "session" or "JSONL" in anthropics/claude-code README or docs → summarize relevant sections, then confirm with index
10. Final analysis: Based on all the above findings, write a 3-sentence summary of what you learned → then confirm with index

---

## Self-Verification (Step 11)

After completing steps 1-10, YOU MUST verify the JSONL recording yourself:

11. **Self-verify JSONL recording:**
    - First, find your current session's JSONL file path using the session ID
    - The path format is: `~/.claude/projects/{encoded-cwd}/{session-id}.jsonl`
    - Run: `grep -oE '\[0[0-9][0-9]\]' <JSONL_PATH> | sort -u` to list all recorded indexes
    - Compare against expected indexes [001] through [011]
    - Report which indexes are MISSING from the JSONL file
    - Then confirm with index

---

## Final Output

After self-verification, output:

```
=== TEST COMPLETE ===
Expected indexes: [001] - [011]
Found in JSONL: [list them]
MISSING from JSONL: [list them or "None"]
```

If any indexes are missing, this confirms the bug.

---

**BEGIN TEST NOW. Start with step 1.**
