# Documentation Writing Guide

Sleep Code 프로젝트의 문서 작성 원칙. 기존 docs를 분석하여 추출한 패턴입니다.

## 5 Principles

### 1. 목적 먼저, 구현은 나중에

- 문서 첫 줄은 "이게 뭔지" 한 문장으로 시작
- 유저 행동 기준으로 구조화: Quick Start → Setup → Usage → Troubleshooting
- "How to" > "How it works"
- 내부 구현 상세는 별도 섹션이나 별도 문서로 분리

```markdown
# Memory System

Sleep Code의 시맨틱 메모리 파이프라인은 대화에서 중요한 정보를 자동으로 기억합니다.

## Quick Start
...
```

### 2. 테이블과 아이콘으로 비교

- 두 가지 이상 비교할 때는 산문 대신 비교 테이블
- 상태값은 아이콘으로 일관되게 표시
  - 지원 여부: ✅ ❌ ⚠️
  - 상태: 🟢 🟡 🔴
  - 세션: 🔄 (시작) 🟢 (실행 중) 🟡 (대기) ⚫ (종료)
- 기능 매트릭스로 한눈에 파악 가능하게

```markdown
| Feature | PTY | SDK |
|---------|-----|-----|
| Session resume | ✅ `/claude restore` | ✅ Lazy resume |
| Terminal window | ✅ | ❌ |
| Permission buttons | ✅ | ✅ |
```

### 3. 코드 예시는 복사해서 바로 실행 가능

- bash 스니펫은 copy-paste ready (placeholder 최소화)
- JSON/config 예시는 실제 구조 사용 (pseudocode 금지)
- 검증 명령어 포함: "이 로그가 나오면 성공"
- 언어 태그 필수: ` ```bash `, ` ```typescript `, ` ```json `

```markdown
## Verify Installation

pm2 logs sleep-discord --lines 5 --nostream

# Expected output:
# {"level":"info","msg":"Discord bot ready"}
```

### 4. 제약사항과 한계를 명시적으로

- "Limitations" 또는 "Differences from..." 섹션 별도로 둠
- 타임아웃, 기본값, 임계값은 숫자로 표기
- 안 되는 것은 ❌로 명확히 표시
- "주의" 사항은 `> **Note:**` callout 사용

```markdown
## Limitations

- SDK sessions do not support terminal window display ❌
- Permission timeout: 5 minutes (default)
- Max file upload: 100KB

> **Note:** YOLO mode auto-approves all permissions except `ExitPlanMode`.
```

### 5. 단일 출처 원칙 (Single Source of Truth)

- 커맨드 레퍼런스: `docs/commands.md` 한 곳에만
- 아키텍처 트리: `CLAUDE.md` 한 곳에만
- Config/env 변수 테이블: `CLAUDE.md` 한 곳에만
- 다른 문서에서는 참조 링크만 사용
- 중복 작성 시 반드시 어느 쪽이 정본(canonical)인지 명시

```markdown
## Commands

See [commands.md](commands.md) for the full slash command reference.
```

## Document Structure Template

새 문서를 작성할 때 아래 구조를 기본으로 합니다:

```markdown
# {Feature Name}

{한 줄 설명}

## Quick Start

{가장 빠르게 시작하는 방법}

## Setup / Prerequisites

{필요한 사전 조건}

## Usage

{주요 사용법, 커맨드, 설정}

## Configuration

{설정 파일, 환경변수, 기본값}

## Architecture (optional)

{내부 동작, 데이터 흐름}

## Troubleshooting

{증상 → 해결 방법}

## Limitations

{알려진 제약사항}
```

## Heading Hierarchy

- `#` — 문서 제목 (파일당 1개)
- `##` — 주요 섹션 (Setup, Usage, Troubleshooting)
- `###` — 하위 섹션 (개별 커맨드, 예시)
- 4단계 이상 사용 금지

## Language

- 한국어 문서와 영어 문서는 별도 파일로 분리 (번역 마커 금지)
- 기술 용어는 프로젝트 전체에서 일관되게 사용
  - "lazy resume", "YOLO mode", "distill", "topicKey" 등
- 한/영 동시 사용 시 영어 원문 유지 (e.g., "Codex", "SessionStore")
