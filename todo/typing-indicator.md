# Discord Typing Indicator 개선

## 목표
Claude가 thinking 중일 때 Discord에서 typing indicator 표시

## 문제
- JSONL에 thinking 시작/종료 이벤트 없음
- 현재 `onSessionStatus`가 호출되지 않아 typing indicator 미작동

## 검토한 방안들

| 방안 | 설명 | 문제점 |
|------|------|--------|
| A | user→running, assistant→idle | 첫 청크에서 바로 idle |
| B | user→running, 다음 user→idle | 응답 끝나도 typing 유지 |
| C | 타임아웃 기반 (3초) | 딜레이 |
| D | requestId 변경 감지 | 사용자 메시지 전까지 running |
| D+타임아웃 | requestId + 3초 타임아웃 | 복잡함, 별로 |

## 상태
폐기 - 더 나은 방안 필요

## 대안 아이디어
- PTY 출력 파싱 (스피너, "Thinking..." 등)
- Claude Code hook 활용 (thinking hook이 있는지 확인)
- Anthropic에 JSONL thinking 이벤트 요청
