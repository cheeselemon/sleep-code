# Discord 봇 이중 실행 문제 (2026-02-01)

## 문제점

1. **Discord 봇 이중 실행**
   - PM2에 `sleep-discord`와 `discord` 두 개의 프로세스가 동시에 실행됨
   - 같은 봇이 두 번 로그인되어 Discord API 충돌 발생

2. **증상**
   - 메시지가 Discord로 전송되지 않음
   - `Unknown interaction` 에러 발생 (code: 10062)
   - 권한 요청이 제대로 전달되지 않음

## 원인

- PM2로 봇을 여러 번 실행하면서 중복 인스턴스 생성
- 두 봇이 같은 Discord interaction을 처리하려고 경쟁

## 시도한 해결책

### 1. PM2 프로세스 정리
```bash
pm2 list  # 실행 중인 프로세스 확인
pm2 stop discord  # 중복 프로세스 중지
pm2 restart sleep-discord  # 메인 봇 재시작
```

### 2. 봇 재시작
```bash
pm2 restart sleep-discord
```

## 결과

- 봇 재시작 후 정상 작동 확인
- 권한 요청이 persisted thread로 정상 전송됨
- 메시지 수신/발신 정상화

## 로그 확인 방법

```bash
# 최근 로그 확인
pm2 logs sleep-discord --lines 20 --nostream

# 실시간 로그 모니터링
pm2 logs sleep-discord
```

## 예방책

1. 봇 실행 전 `pm2 list`로 기존 인스턴스 확인
2. 하나의 봇 프로세스만 실행 (`sleep-discord` 사용)
3. 중복 실행 시 `pm2 stop <name>` 으로 정리
