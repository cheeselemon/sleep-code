# JSONL 스트레스 테스트 - 실제 드롭 유발 명령어 사용

실제 대화에서 관찰된 드롭을 기반으로 한 테스트입니다.

## 필수 규칙

1. **모든 응답에 인덱스 필수** - `[001]`, `[002]` 등
2. **인덱스 없는 응답 금지** - "확인 중"도 `[005] 확인 중`으로
3. 매 메시지마다 인덱스 증가

---

## 실제 테스트에서 확인된 드롭 유발 명령어

| 드롭 | 유발 명령어 |
|------|------------|
| [027] | `sleep 5 && echo "done"` |
| [046] | `git add && git commit` |
| [049] | `grep ... \| wc -l` |
| [052] | `grep ... \| wc -l` |
| [057] | `grep ... \| sort -u` |
| [058] | `wc -l` (grep 이후) |

---

## 테스트 순서

각 명령어 실행 후 `[인덱스] 완료`로 응답하세요.

### 라운드 1 (001-005)
1. `git status && git log --oneline -3`
2. `git diff --stat`
3. `grep -r "onMessage" src/ | head -5`
4. `find . -name "*.ts" -type f | wc -l`
5. `ls -la && pwd && whoami`

### 라운드 2 (006-010)
6. `sleep 2 && echo "대기 완료"`
7. `gh issue list --repo anthropics/claude-code --limit 3 2>/dev/null || echo "gh 없음"`
8. `cat package.json | grep -E "name|version"`
9. `git log --oneline -5 && git branch`
10. `grep -rn "JSONL" docs/ 2>/dev/null | head -3 || echo "결과 없음"`

### 검증 (011)
11. JSONL에서 모든 인덱스 추출:
```bash
JSONL=$(ls -t ~/.claude/projects/-*/*.jsonl 2>/dev/null | head -1) && \
grep -oE '"text":"\[0[0-9]{2}\]' "$JSONL" | grep -oE '\[0[0-9]{2}\]' | sort -u | tr '\n' ' '
```

[001]-[010] 중 누락된 인덱스 보고하세요.

### 라운드 3 (012-016) - 갭 없으면 계속
12. `git stash list && git remote -v`
13. `grep -c "function" src/**/*.ts 2>/dev/null || echo "0"`
14. `wc -l src/slack/session-manager.ts`
15. `head -20 src/cli/run.ts | tail -10`
16. `sleep 3 && date`

### 검증 (017)
17. [001]-[016] 갭 확인

---

## 실패할 때까지 계속

016 이후에도 갭 없으면 더 복잡한 명령어로 계속:
- 병렬 명령어: `cmd1 & cmd2 & wait`
- 긴 파이프라인: `cat | grep | sort | uniq | wc`
- Git 작업: `git diff`, `git show` 등

---

## 최종 보고 형식

```
=== JSONL 스트레스 테스트 결과 ===
총 반복 횟수: XX
감지된 갭: [004], [009], [015]
드롭률: X/XX (X%)
공통 유발 패턴: [설명]
```

---

**지금 시작. 명령어 #1 실행: `git status && git log --oneline -3`**
**그 다음 응답: `[001] 완료`**
