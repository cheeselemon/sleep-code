# File Attachment via Marker + Button — Plan

## Goal

Claude가 유저에게 파일(PDF 등)을 명시적으로 보내고 싶을 때 Discord에 XML 마커를 출력하면, 봇이 **파일명이 표시된 버튼**을 렌더한다. 유저가 버튼을 누르면 그 시점에 파일을 attachment로 업로드한다. 자동 업로드/false positive 없이 유저 의사로 수령 여부를 결정하는 흐름.

## Scope

### In

- XML 마커(`<attach>path</attach>`) 파싱 — Claude Agent SDK 세션 응답에서만
- Discord 버튼 렌더 (파일명 라벨)
- CWD 범위 경로 검증
- 1시간 만료
- 동일 버튼 재클릭 시 이전 업로드 메시지 링크로 대체 (재업로드 X)
- 한 메시지당 최대 5개 마커/버튼
- 25MB 초과 파일 감지 및 사용자 통보

### Out

- 자동 업로드 (버튼 없이 경로만으로 업로드) — 채택 안 함
- CWD 외 경로 허용 — 일단 안 함 (추후 확장 여지만 남김)
- 배치 다운로드 (한 버튼으로 여러 파일)
- PTY 세션 지원 — 1차 범위에서는 SDK 세션만 (PTY는 Claude가 구조화 출력 감지 어려움)

## Marker Format

```xml
<attach>/absolute/path/to/file.pdf</attach>
```

규칙:
- 절대 경로 필수
- 세션 CWD 하위 경로여야 함 (canonicalize 후 prefix 검증, `..` 이스케이프 차단)
- Claude 응답 텍스트 내 인라인 어디든 가능
- 응답 스트림 **완료 후** 파싱 (partial 상태에서 파싱하지 않음)
- 여러 개 허용, 6개 이상이면 앞 5개만 버튼화하고 로그 경고

CLAUDE.md/AGENTS.md에 규약 문서화 → Claude가 상황 인지하고 사용.

## UI

### 봇 렌더 메시지

```
Claude의 응답 텍스트...

📎 첨부 파일 (클릭해서 받기)
[📎 report.pdf]  [📎 chart.png]  [📎 data.csv]
```

- 라벨 형식: `📎 {basename}` (파일명만, 경로 숨김)
- 최대 5개 버튼 (Discord 한 row 한도)
- 버튼 style: Secondary (회색) — 중요도 낮은 옵션 표현

### 버튼 클릭 흐름

```
1. 클릭
2. defer → 검증
   - 파일 존재 확인
   - CWD 하위 확인
   - 크기 ≤ 25MB 확인
3a. 첫 클릭 + 검증 통과
    → 스레드에 파일 업로드 (attachment)
    → 업로드된 메시지 URL을 mapping에 저장
    → ephemeral "첨부했습니다" 알림
3b. 재클릭 + 이미 업로드됨
    → ephemeral로 기존 업로드 메시지 링크 전달
    → "이미 이 메시지에 첨부되어 있습니다: {url}"
3c. 검증 실패
    → ephemeral 에러 메시지:
      - 파일 없음: "파일이 더 이상 존재하지 않습니다"
      - 경로 밖:  "세션 디렉토리 밖 경로는 허용되지 않습니다"
      - 크기 초과: "파일 크기 {실제}MB > 25MB 제한"
```

### 만료

- 렌더 시각 + 1시간 경과 → 버튼 disable 처리
- 만료 시 메시지 edit: 버튼 `[📎 report.pdf (만료)]` + disabled=true
- 구현 방식: 백그라운드 타이머 (node `setTimeout`) + persisted state로 bot restart 대응

## Persistence

`~/.sleep-code/attach-buttons.json`:

```json
{
  "<customId>": {
    "sessionId": "a88...",
    "threadId": "123...",
    "messageId": "456...",
    "filePath": "/abs/path/report.pdf",
    "cwd": "/abs/path",
    "renderedAt": "2026-04-22T00:57:00Z",
    "uploadedMessageUrl": "https://discord.com/..." | null
  }
}
```

- 클릭 시: `uploadedMessageUrl` 기록
- Bot restart 시: 로드 → 남은 만료 시간 기반 타이머 재설정 → 만료된 항목은 edit만 처리 후 삭제

## Security

- `filePath` 절대 경로 필수
- `path.resolve(filePath)`이 `path.resolve(session.cwd)` 접두어와 일치해야 통과 (symlink 해석 포함)
- 허용 확장자 화이트리스트 여부: **없음** — CWD 제한으로 충분하다 판단
- Claude가 악의적 경로를 마커로 찍어도 CWD 밖이면 봇이 거부

## Affected Files

### Runtime code
| 파일 | 역할 |
|------|------|
| `src/discord/claude-sdk/claude-sdk-handlers.ts` | 응답 텍스트에서 `<attach>` 파싱, 버튼 렌더 |
| `src/discord/interactions/attach-button.ts` | **신규** — 버튼 클릭 핸들러 |
| `src/discord/attach-store.ts` | **신규** — JSON persist + 만료 타이머 |
| `src/discord/utils.ts` | 기존 attachment 유틸 재사용 (필요 시 소규모 확장) |
| `src/discord/discord-app.ts` | 버튼 interaction 라우팅 등록 + 시작 시 store load |

### Documentation & Skills
`AGENTS.md`에 규약 넣는 것만으로는 부족함 — `/sc-install` 스킬이 다른 프로젝트의 AGENTS.md에 이 규약을 뿌려야 다른 프로젝트에서 작업하는 Claude도 이 기능의 존재를 알고 사용함. 따라서 스킬 3곳 동기화(정본 + 설치 스킬 + 설치 사본) 규칙대로 함께 업데이트 필요.

| 파일 | 역할 |
|------|------|
| `AGENTS.md` (sleep-code 레포) | "## File Delivery via `<attach>` Marker" 섹션 신설, 마커 규약 문서화 (CLAUDE.md는 심볼릭 링크라 자동 반영) |
| `docs/sdk-session.md` | SDK 세션 기능 섹션에 한 줄 언급 |
| `docs/skills/install.md` (정본) | `### Template: File Delivery via <attach> Marker` 신규 템플릿 추가 → 설치 시 대상 프로젝트 AGENTS.md/CLAUDE.md에 삽입되도록 |
| `.claude/commands/sc-install.md` (설치 스킬) | 동일 내용 동기화 |
| `~/.claude/commands/sc-install.md` (설치 사본) | 기기에 설치되어 있는 경우 동일 동기화 (없으면 skip) |
| `docs/commands.md` | 해당 없음 (슬래시 커맨드 변경 없음) |

## Step-by-Step Tasks

1. `AttachStore` 클래스 (`src/discord/attach-store.ts`) — Map + JSON 파일 저장 + 만료 타이머 관리
2. 마커 파서 유틸 — `<attach>path</attach>` 추출 (`/<attach>([^<]+)<\/attach>/g`)
3. 핸들러 확장 — Claude SDK `onMessage`에서 응답 완료 후 마커 파싱 → CWD 검증 → 버튼 렌더 + AttachStore 기록
4. 버튼 interaction 핸들러 — customId `attach:<uuid>` 패턴, 클릭 시 검증 + 업로드 또는 에러 ephemeral
5. Discord 앱 초기화 로직 — 시작 시 `AttachStore.load()` 호출, 진행 중 타이머 복원
6. AGENTS.md에 규약 섹션 추가 → Claude가 자연스럽게 사용하게 유도
7. `docs/skills/install.md` 정본에 `### Template: File Delivery via <attach> Marker` 추가
8. `.claude/commands/sc-install.md`에 동일 템플릿 동기화 (+ 설치 사본 있으면 함께)
9. `docs/sdk-session.md`에 기능 언급 추가
10. 수동 테스트 플로우:
   - Claude가 `<attach>/cwd/test.pdf</attach>` 출력 → 버튼 렌더 확인
   - 클릭 → 첨부 업로드 확인
   - 재클릭 → ephemeral 링크 확인
   - CWD 외 경로 → 에러 확인
   - 크기 초과 파일 → 에러 확인
   - 1시간 경과 → 버튼 disable 확인
   - 봇 재시작 후에도 동일 동작 확인

## Acceptance Criteria

- [ ] Claude SDK 세션에서 `<attach>{cwd-path}</attach>` 출력 시 버튼이 렌더됨
- [ ] 버튼 라벨은 파일명(basename)만, 경로 노출 안 됨
- [ ] 최초 클릭 시 파일이 스레드에 attachment로 업로드됨
- [ ] 같은 버튼 재클릭 시 ephemeral로 기존 업로드 URL 링크 전달 (재업로드 없음)
- [ ] CWD 외부 경로 마커는 업로드 시도 시 ephemeral 에러
- [ ] 존재하지 않는 파일 → ephemeral 에러
- [ ] 25MB 초과 파일 → 실제 크기 수치 포함 ephemeral 에러
- [ ] 한 메시지 최대 5개 버튼, 6개 이상은 앞 5개만 + 로그 경고
- [ ] 1시간 후 버튼 disabled 표시로 변경
- [ ] Bot restart 이후에도 기존 버튼 작동 (만료 전이면)
- [ ] AGENTS.md에 마커 규약 섹션 추가됨
- [ ] `docs/skills/install.md` 정본 + `.claude/commands/sc-install.md`에 템플릿 추가, 두 파일 내용 동일
- [ ] `/sc-install`을 다른 프로젝트에 돌리면 해당 프로젝트 AGENTS.md/CLAUDE.md에도 마커 규약이 삽입됨
- [ ] `npm run build` 성공

## Estimated Effort

약 150~250줄 (런타임) + 스킬/문서 ~100줄. 수동 테스트 포함 2.5~3.5시간.

## Notes

- 이 기능은 **Claude SDK 세션 전용**. PTY 세션은 구조화 출력 감지가 어려워 1차 제외.
- Codex 출력에도 같은 마커를 허용할지는 향후 확장 사항 (지금은 Claude SDK만).
- 25MB 한도는 Discord 기본 서버 기준. Nitro 서버(50MB/100MB/500MB) 대응은 추후 필요 시.
