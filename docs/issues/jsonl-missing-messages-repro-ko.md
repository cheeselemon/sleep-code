# JSONL 메시지 기록 테스트 (한글 버전)

버그 리포트를 위한 JSONL 메시지 기록 신뢰성 테스트입니다.

## 중요 지시사항

**모든 응답은 반드시 `[001]`, `[002]`, `[003]` 형식의 증분 인덱스로 시작해야 합니다.**

예외 없이 모든 응답에 필수입니다. `[001]`부터 시작하세요.

각 도구 작업 후, 인덱스 접두사와 함께 **한글로** 짧은 확인 메시지(1-2문장)를 작성하세요.

---

## 테스트 순서

다음 단계를 순서대로 수행하세요:

1. 웹 검색: "Claude Code CLI 최신 기능 2026" → 상위 3개 결과 한글로 요약, 인덱스로 확인
2. 웹 검색: "Anthropic Claude API 스트리밍 모범 사례" → 결과 한글로 요약, 인덱스로 확인
3. GitHub 이슈 검색: `gh issue list --repo anthropics/claude-code --limit 10 --state open --label bug` → 한글로 나열, 인덱스로 확인
4. 위 목록에서 2개 이슈 **병렬로** 조회 → 두 이슈 한글로 요약, 인덱스로 확인
5. 이슈 검색: `gh search issues "JSONL session message" --repo anthropics/claude-code --limit 5` → 유사 버그 있는지 한글로 분석, 인덱스로 확인
6. 4개 명령어 **병렬 실행**: `gh repo view anthropics/claude-code --json description`, `gh issue list --repo anthropics/claude-code --limit 3 --label enhancement`, `git log --oneline -5`, `git diff --stat` → 모든 결과 한글로 종합, 인덱스로 확인
7. Grep으로 프로젝트 전체에서 "onMessage" 검색 후 코드 흐름 분석 → 한글로 설명, 인덱스로 확인
8. Glob으로 모든 TypeScript 파일 찾고, `wc -l`로 총 라인 수 계산 → 한글로 통계 보고, 인덱스로 확인
9. Claude Code 문서에서 "session" 또는 "JSONL" 관련 내용 탐색 → 한글로 관련 섹션 요약, 인덱스로 확인
10. 최종 분석: 위 모든 결과를 바탕으로 배운 것 3문장으로 한글 요약 → 인덱스로 확인

---

## 자체 검증 (11단계)

1-10단계 완료 후, 직접 JSONL 기록을 검증하세요:

11. **JSONL 기록 자체 검증:**
    - 현재 세션의 JSONL 파일 경로 찾기 (세션 ID 사용)
    - 경로 형식: `~/.claude/projects/{encoded-cwd}/{session-id}.jsonl`
    - 실행: `grep -oE '\[0[0-9][0-9]\]' <JSONL_PATH> | sort -u` 로 기록된 인덱스 확인
    - 예상 인덱스 [001] ~ [011]과 비교
    - JSONL에서 누락된 인덱스 한글로 보고
    - 인덱스로 확인

---

## 최종 출력

자체 검증 후 출력:

```
=== 테스트 완료 ===
예상 인덱스: [001] - [011]
JSONL에서 발견: [목록]
JSONL에서 누락: [목록 또는 "없음"]
```

누락된 인덱스가 있으면 버그가 확인된 것입니다.

---

**지금 테스트를 시작하세요. 1단계부터 시작하세요.**
