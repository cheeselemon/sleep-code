# Sleep Code

[English](README.md) | [한국어](README.ko.md)

<p align="center">
  <img width="256" height="256" alt="Sleep Code" src="https://github.com/user-attachments/assets/2e82e717-c957-4be3-827c-f03e22cfaa07" />
</p>

<p align="center">
  <strong>누워서 코딩하세요.</strong> Discord, Slack, Telegram에서 Claude Code 세션을 모니터링하고 제어하세요.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sleep-code"><img src="https://img.shields.io/npm/v/sleep-code" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node 18+">
</p>

## Sleep Code란?

Sleep Code는 Claude Code(와 Codex)를 채팅 플랫폼과 연결합니다. 코딩 세션을 시작하고 자리를 비운 뒤에도 폰에서 계속 작업 — 권한 승인, 지시 전달, 결과 확인을 실시간으로 할 수 있습니다.

## 주요 기능

- **양방향 메시징** — 채팅 ↔ Claude Code 실시간 연동
- **권한 처리** — Discord/Slack 버튼으로 도구 호출 승인/거부
- **YOLO 모드** — 모든 권한 자동 승인 (주의해서 사용)
- **세션 관리** — Discord에서 세션 시작, 중지, 복구
- **Claude Agent SDK** — 터미널 없이 SDK `query()`로 세션 실행
- **모델 & 컨텍스트 선택** — 세션 시작 시 Opus 4.7/4.6, Sonnet 4.6, Haiku 4.5 중 선택하고, 지원되는 200K 또는 1M 컨텍스트 옵션 사용
- **Codex 연동** — 같은 스레드에서 Claude와 OpenAI Codex를 함께 실행
- **시맨틱 메모리** — 대화를 자동 정제 → 로컬 벡터 DB, 일일 다이제스트 브리핑
- **멀티 플랫폼** — Discord (전체 기능), Slack, Telegram

## 빠른 시작

```bash
git clone https://github.com/cheeselemon/sleep-code.git
cd sleep-code && npm install && npm run build

# Discord (추천)
npm run discord:setup   # 봇 토큰 + 사용자 ID 입력
npm run discord         # 봇 시작

# 권한 훅 (원격 승인/거부 활성화)
npm run hook:setup

# 모니터링되는 Claude 세션 시작
npm run claude
```

Telegram, Slack, 상세 설정 → [설치 가이드](docs/setup.md)

## 작동 방식

```
사용자 (Discord/Slack/Telegram)
  ↕ 메시지 + 권한 버튼
Sleep Code 봇 (Unix 소켓 데몬)
  ↕ PTY 또는 Claude Agent SDK
Claude Code / Codex
```

1. `npm run discord`로 Unix 소켓에서 대기하는 봇 시작
2. `npm run claude`로 PTY에서 Claude를 생성하고 봇에 연결
3. 메시지가 양방향 전달: Claude ↔ 봇 ↔ 채팅
4. 권한 요청이 채팅으로 전달되어 버튼으로 승인

## 문서

| 문서 | 내용 |
|------|------|
| **[설치 가이드](docs/setup.md)** | 설치, 플랫폼 인증, 환경 변수 |
| **[실행 가이드](docs/running.md)** | PM2 백그라운드, MCP 서버, Memory Explorer |
| **[명령어 레퍼런스](docs/commands.md)** | 슬래시 명령어, Memory CLI, 플랫폼 비교 |
| **[메모리 시스템](docs/memory.md)** | Distill 파이프라인, 통합 정리, 일일 다이제스트, 커스텀 프롬프트 |
| **[아키텍처](docs/architecture.md)** | 컴포넌트 상세, 데이터 플로우, 설정 파일 |
| **[SDK 세션](docs/sdk-session.md)** | Claude Agent SDK 세션 생명주기 및 복구 |
| **[Codex 연동](docs/codex-integration.md)** | 멀티 에이전트 설정 및 메시지 라우팅 |
| **[문제 해결](docs/troubleshooting.md)** | 알려진 문제 및 디버깅 |

## 시맨틱 메모리 (선택사항)

대화를 Claude SDK + Ollama 임베딩으로 자동 정제하여 로컬 벡터 DB에 저장합니다. 결정, 사실, 선호사항은 기억하고, 일상 대화는 필터링합니다.

- **배치 정제** — Claude SDK(sonnet)가 메시지를 배치 분류, open task 주입·2차 검증·자동 task resolution
- **일일 다이제스트** — 정기 브리핑 (기본 10:00, 16:00, 21:00 KST), pre-consolidation 포함
- **통합 정리** — 중복 자동 병합, 스마트 task 자동 해결 (4단계 전략), 24시간 주기
- **커스텀 프롬프트** — `~/.sleep-code/digest-prompt.txt`로 다이제스트 출력 커스터마이징

임베딩에 [Ollama](https://ollama.com/) 필요. Ollama 없이도 메모리 기능만 빠지고 봇은 정상 작동.

→ 전체 내용: **[메모리 시스템](docs/memory.md)**

## 기여

기여를 환영합니다! 변경하려는 내용을 먼저 이슈로 논의해 주세요.

개발 환경 설정과 가이드라인은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고하세요.

## 감사의 말

- @clharman의 [afk-code](https://github.com/clharman/afk-code)에서 영감을 받아 시작되었습니다
- **OpenCode 사용자?** [Disunday](https://github.com/code-xhyun/disunday)를 확인하세요 — 같은 컨셉, 다른 AI 백엔드

## 라이선스

[MIT](LICENSE)
