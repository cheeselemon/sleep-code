# JSONL Stress Test - Using Proven Drop Triggers

Based on actual drops observed in conversation, these commands trigger JSONL message drops.

## CRITICAL RULES

1. **EVERY response MUST have index prefix** - `[001]`, `[002]`, etc.
2. **NO response without index** - even "checking" must be `[005] checking`
3. Increment index for EVERY message

---

## Proven Drop Triggers (from real testing)

| Drop | Command That Triggered |
|------|----------------------|
| [027] | `sleep 5 && echo "done"` |
| [046] | `git add && git commit` |
| [049] | `grep ... \| wc -l` |
| [052] | `grep ... \| wc -l` |
| [057] | `grep ... \| sort -u` |
| [058] | `wc -l` after grep |

---

## Test Sequence

Execute these commands in order. After EACH command, respond with `[INDEX] done`.

### Round 1 (001-005)
1. `git status && git log --oneline -3`
2. `git diff --stat`
3. `grep -r "onMessage" src/ | head -5`
4. `find . -name "*.ts" -type f | wc -l`
5. `ls -la && pwd && whoami`

### Round 2 (006-010)
6. `sleep 2 && echo "waited"`
7. `gh issue list --repo anthropics/claude-code --limit 3 2>/dev/null || echo "gh not available"`
8. `cat package.json | grep -E "name|version"`
9. `git log --oneline -5 && git branch`
10. `grep -rn "JSONL" docs/ 2>/dev/null | head -3 || echo "no matches"`

### Verification (011)
11. Extract all indexes from JSONL and find gaps:
```bash
JSONL=$(ls -t ~/.claude/projects/-*/*.jsonl 2>/dev/null | head -1) && \
grep -oE '"text":"\[0[0-9]{2}\]' "$JSONL" | grep -oE '\[0[0-9]{2}\]' | sort -u | tr '\n' ' '
```

Report: which indexes from [001]-[010] are MISSING?

### Round 3 (012-016) - if no gaps yet
12. `git stash list && git remote -v`
13. `grep -c "function" src/**/*.ts 2>/dev/null || echo "0"`
14. `wc -l src/slack/session-manager.ts`
15. `head -20 src/cli/run.ts | tail -10`
16. `sleep 3 && date`

### Verification (017)
17. Check for gaps in [001]-[016]

---

## Continue Until Failure

If no gaps after 016, continue with more complex commands:
- Parallel commands: `cmd1 & cmd2 & wait`
- Long pipelines: `cat | grep | sort | uniq | wc`
- Git operations: `git diff`, `git show`, etc.

---

## Final Report Format

```
=== JSONL STRESS TEST RESULT ===
Total iterations: XX
Gaps detected: [004], [009], [015]
Drop rate: X/XX (X%)
Common trigger pattern: [describe]
```

---

**START NOW with command #1: `git status && git log --oneline -3`**
**Then respond: `[001] done`**
