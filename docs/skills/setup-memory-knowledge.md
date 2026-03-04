---
name: sc-setup-memory-knowledge
description: "Add memory & knowledge system documentation to the current project's CLAUDE.md and AGENTS.md. Explains how the automatic memory pipeline works and how to use recall tools."
disable-model-invocation: true
---

# Setup Memory & Knowledge System

Set up the memory & knowledge system documentation for the current project.

## Steps

1. Read the current project's `CLAUDE.md`.
2. If a `Memory & Knowledge System` section already exists, inform "Already configured" and stop.
3. Otherwise, append the section below to `CLAUDE.md`. Create the file if it doesn't exist.
4. If `AGENTS.md` exists, add the same section. Otherwise, create it.
5. Replace `{PROJECT_NAME}` with the last directory component of the current working directory (e.g., `/Users/foo/projects/my-app` → `my-app`).

## Section to Add

Add the content below as-is (markdown inside the code block), after replacing `{PROJECT_NAME}`:

```markdown
## Memory & Knowledge System

이 프로젝트의 대화는 sleep-code memory 파이프라인에 의해 자동으로 기억됩니다.

### 동작 원리
1. Discord/터미널 대화가 실시간으로 수집됨
2. 로컬 LLM(Ollama qwen2.5:7b)이 각 메시지를 분류 — 기억할 가치가 있으면 distill
3. LanceDB에 벡터 임베딩과 함께 저장 (프로젝트별 분리)
4. 중복 기억은 자동 병합 (cosine similarity 0.85 이상)

### 저장되는 데이터
- **decision**: 의사결정 (예: "환불 로직은 계약일 기준 30일 이내 면제")
- **fact**: 확인된 사실 (예: "API 비용은 쓰지 않기로 함")
- **preference**: 선호/방침 (예: "Ollama 로컬 모델만 사용")
- **task**: 할당된 작업
- **proposal**: 제안사항
- **feedback**: 피드백

각 기억에는 project, speaker, priority(0-10), topicKey가 태깅됨.

### 사용법 (MCP Tools)
- `sc_memory_search` — 시맨틱 검색. "환불 로직 어떻게 하기로 했지?" 같은 질문에 관련 기억 반환
- `sc_memory_list` — 프로젝트의 최근 기억 목록
- `sc_memory_store` — 유저가 "기억해", "저장해" 등 명시적으로 요청했을 때만 사용한다.

### 이 프로젝트 설정
- project name: `{PROJECT_NAME}`
- 검색 예: `sc_memory_search(query="...", project="{PROJECT_NAME}")`
```

## Rules

- Never delete existing content in CLAUDE.md / AGENTS.md. Only append sections.
- After adding, report which files were modified and what was added.
