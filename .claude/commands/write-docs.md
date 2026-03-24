---
name: write-docs
description: "Write or update documentation following the project's writing guide. Loads docs/writing-guide.md and applies the 5 principles."
---

# Documentation Writer

프로젝트의 문서 작성 가이드라인에 따라 문서를 작성하거나 업데이트합니다.

## Steps

1. Read the writing guide at `docs/writing-guide.md` in the current project root.

2. If the user specifies a target file, read that file first. If creating a new file, use the Document Structure Template from the writing guide.

3. Apply all 5 principles:
   - **목적 먼저**: 첫 줄에 한 문장 설명. 유저 행동 기준 구조.
   - **테이블과 아이콘**: 비교는 테이블. 상태는 ✅ ❌ 🟢 🟡 🔴.
   - **실행 가능한 코드**: copy-paste ready. 검증 명령어 포함.
   - **제약사항 명시**: Limitations 섹션. 숫자로 기본값 표기.
   - **단일 출처**: 중복 작성 금지. 정본 문서에 링크.

4. Follow heading hierarchy: `#` (1개), `##` (주요), `###` (하위). 4단계 금지.

5. Write or update the documentation. Show the user what changed.

## Input

$ARGUMENTS

If no arguments provided, ask the user what documentation to write or update.
