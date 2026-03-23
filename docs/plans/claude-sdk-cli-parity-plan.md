# Claude SDK CLI Parity Clarification Plan

## Goal

Claude SDK 세션이 Claude Code CLI와 최대한 유사한 설정 소스를 사용한다는 점을 코드와 문서에 명확히 고정한다.

핵심 목표:

- SDK 세션이 `settingSources: ["user", "project", "local"]`를 사용한다는 의도를 명시
- 향후 리팩터링에서 이 설정이 무심코 변경되지 않도록 회귀 방지
- 사용자 문서에 실제 동작과 한계를 정확히 반영

## Scope

이번 작업은 새로운 SDK 기능 추가가 아니다.

- 포함:
  - Claude SDK 세션 초기화 코드의 의도 명시
  - 문서에 setting source 동작 설명 추가
  - SDK와 CLI의 차이점 중 중요한 제한 사항 명시
- 제외:
  - 권한 처리 구조 변경
  - 세션 시작 UX 변경
  - 설정 파일로 `settingSources`를 외부화하는 기능 추가

## Current State

현재 구현은 이미 CLI 유사 설정을 사용하고 있다.

- `query()` 호출 시 `settingSources: ['user', 'project', 'local']` 사용
- 세션 시작과 복구 모두 선택된 `cwd`를 그대로 SDK에 전달
- 문서에는 이 동작이 아직 명확히 설명되어 있지 않음

즉, 실질적인 수정 포인트는 런타임 동작보다 “명시성”과 “문서 정합성”이다.

## Affected Files

- `src/discord/claude-sdk/claude-sdk-session-manager.ts`
- `docs/sdk-session.md`

## Implementation Tasks

### Step 1: CLI parity intent를 코드에 고정

**파일:** `src/discord/claude-sdk/claude-sdk-session-manager.ts`

- `settingSources: ['user', 'project', 'local']`를 인라인 리터럴로 두지 말고 상수로 추출
- 상수 이름은 의도가 드러나게 작성
  - 예: `CLAUDE_CODE_COMPAT_SETTING_SOURCES`
- 짧은 주석으로 이 값이 “Claude Code CLI와 최대한 같게 맞춘 설정”임을 명시

예상 형태:

```ts
const CLAUDE_CODE_COMPAT_SETTING_SOURCES = ['user', 'project', 'local'] as const;
```

그리고 `query()` 옵션에서 해당 상수를 사용한다.

### Step 2: 사용자 문서에 실제 동작 추가

**파일:** `docs/sdk-session.md`

문서에 아래 내용을 추가한다.

- SDK 세션이 `user`, `project`, `local` setting source를 모두 로드한다는 설명
- 따라서 `CLAUDE.md`, project rules, skills, hooks, local settings가 반영된다는 설명
- `cwd`가 project/local 탐색 기준이라는 설명
- SDK는 Claude Code CLI의 auto memory (`~/.claude/projects/.../memory/`)를 로드하지 않는다는 제한

문서 위치 후보:

- Overview 아래 “CLI parity” 짧은 섹션 추가
- 또는 Quick Start 이후 “Settings Sources” 섹션 추가

### Step 3: 빌드 검증

- `npm run build` 실행
- 타입 오류나 문서 수정으로 인한 부수 영향이 없는지 확인

## Acceptance Criteria

- Claude SDK 세션 초기화 코드에서 CLI parity setting source가 상수/주석으로 명확히 표현된다
- 사용자 문서에서 SDK가 어떤 setting source를 로드하는지 바로 확인할 수 있다
- 문서에 SDK와 CLI의 auto memory 차이가 명시된다
- `npm run build`가 성공한다

## Notes

- 현재 코드상 기능 동작은 이미 요구사항을 만족하므로, 이번 변경은 동작 수정이 아니라 유지보수성 향상이다
- 향후 필요하면 `settingSources`를 사용자 설정으로 외부화할 수 있지만, 이번 범위에는 포함하지 않는다
