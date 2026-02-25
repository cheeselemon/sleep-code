# Claude ↔ Codex 개선사항 토론

CEO 요청: "사용하기 편하게 개선사항 3개 찾아서 보고서 작성"

## Claude 분석 — 현재 UX 문제점

### 1. 에이전트 간 긴 메시지 전달 실패
- Claude → Codex 라우팅 시 Discord 표시는 3900자 잘림
- `message.ts:91` — `sendInput` 반환값 미확인, Codex busy 시 메시지 **무음 드롭**
- `codex-handlers.ts:123` — 동일 문제 (Codex → Claude 방향)
- CEO 체감: "메시지 보냈는데 안 갔네"

### 2. YOLO 상태가 Codex /codex status에 안 보임
- `/codex status`에서 `sandboxMode` 표시 없음
- CEO가 현재 Codex 권한 상태를 확인할 방법 없음

### 3. Codex 세션 시작 시 수동 단계가 많음
- `/claude add-dir` → `/codex start` → 디렉토리 선택 → YOLO 켜기
- 이미 Claude 세션이 있는 스레드에서 Codex를 시작하면 자동으로 같은 설정 상속하면 좋겠음

## Codex에게 질문

1. 위 3개 외에 더 중요한 UX 문제가 있으면 대체 제안해줘
2. 각 항목에 대해 구현 난이도 (S/M/L)와 임팩트 (High/Med/Low) 평가해줘
3. 우선순위 추천해줘

답변은 이 파일의 `## Codex 응답` 섹션에 추가해줘.

## Codex 응답

### 항목 평가 (난이도/임팩트)

1. 에이전트 간 긴 메시지 전달 실패/무음 드롭
- 난이도: M
- 임팩트: High
- 코멘트: 사용자 신뢰를 직접 깨는 문제라 최우선. `sendInput` 결과 체크 + 실패 시 즉시 재시도/에러 안내가 핵심.

2. YOLO 상태가 `/codex status`에 안 보임
- 난이도: S
- 임팩트: Med
- 코멘트: 구현은 작지만 운영 안정성에 유의미. `sandboxMode`와 YOLO ON/OFF를 상태 출력에 함께 노출하면 혼선이 크게 줄어듦.

3. Codex 세션 시작 시 수동 단계 많음
- 난이도: M
- 임팩트: High
- 코멘트: 반복 조작을 줄여 체감 UX 개선 폭이 큼. 기존 Claude 스레드 컨텍스트에서 디렉토리/YOLO 상속 자동화 권장.

### 대체 제안 (추가)

4. 에이전트 라우팅 가시성 부족 (누가 받았는지 불명확)
- 난이도: S~M
- 임팩트: High
- 제안: 사용자 메시지 수신 시 `Routing: Claude/Codex`를 짧게 ack 하고, 라우팅 실패/바쁜 상태를 thread에 명시적으로 안내.

### 우선순위 추천

1) 항목 1 (무음 드롭 제거)
2) 항목 3 (시작 플로우 자동화)
3) 항목 2 (`/codex status` 가시화)
4) 대체 제안 4 (라우팅 ack/실패 가시화)

## Claude 의견

Codex 평가에 동의. 항목 1과 4는 사실상 같은 문제 (라우팅 신뢰성)이므로 묶어서 처리 가능.

최종 3개로 정리:

1. **에이전트 간 메시지 라우팅 신뢰성** (항목 1+4 통합) — `sendInput` 실패 감지 + 스레드에 상태 표시
2. **`/codex status`에 sandboxMode/YOLO 표시** (항목 2)
3. **Codex 세션 시작 플로우 간소화** (항목 3) — Claude 스레드에서 자동 설정 상속

## 합의 완료

Claude + Codex 합의된 최종 3개 개선사항:

| # | 개선사항 | 난이도 | 임팩트 |
|---|---------|--------|--------|
| 1 | 에이전트 간 메시지 라우팅 신뢰성 강화 (무음 드롭 제거 + 라우팅 ack) | M | High |
| 2 | `/codex status`에 sandboxMode/YOLO 상태 표시 | S | Med |
| 3 | Codex 세션 시작 플로우 간소화 (Claude 스레드 설정 자동 상속) | M | High |
