import { ClaudeChatProvider, ChatService, DistillService } from './index.js';

async function main() {
  const chatProvider = new ClaudeChatProvider({ model: 'haiku' });
  const chatService = new ChatService(chatProvider);
  await chatService.initialize();
  const distill = new DistillService(chatService);

  const start = Date.now();

  // Test 1: "ㅇㅇ" with decision context
  console.log('=== Test 1: "ㅇㅇ" with decision context ===');
  const t1 = Date.now();
  const r1 = await distill.distill({
    message: { speaker: 'user', content: 'ㅇㅇ', timestamp: new Date().toISOString() },
    context: [
      { speaker: 'claude', content: '벡터 DB를 LanceDB로 결정할까요?' },
      { speaker: 'user', content: '로컬에서 돌릴 수 있는거 맞지?' },
      { speaker: 'claude', content: '네, 서버 없이 임베디드로 돌아갑니다. LanceDB로 갈까요?' },
    ],
  });
  console.log(`  (${Date.now() - t1}ms)`);
  console.log(JSON.stringify(r1, null, 2));

  // Test 2: "ㅇㅇ" with casual context
  console.log('\n=== Test 2: "ㅇㅇ" with casual context ===');
  const t2 = Date.now();
  const r2 = await distill.distill({
    message: { speaker: 'user', content: 'ㅇㅇ', timestamp: new Date().toISOString() },
    context: [
      { speaker: 'claude', content: '밥 드셨어요?' },
    ],
  });
  console.log(`  (${Date.now() - t2}ms)`);
  console.log(JSON.stringify(r2, null, 2));

  // Test 3: Technical feedback
  console.log('\n=== Test 3: Technical feedback ===');
  const t3 = Date.now();
  const r3 = await distill.distill({
    message: { speaker: 'user', content: 'API 비용은 절대 쓰고 싶지 않아. Pro 구독으로만 해결하자.', timestamp: new Date().toISOString() },
    context: [
      { speaker: 'claude', content: '사고 엔진을 API SDK로 할까요, 세션 스폰으로 할까요?' },
    ],
  });
  console.log(`  (${Date.now() - t3}ms)`);
  console.log(JSON.stringify(r3, null, 2));

  console.log(`\nTotal: ${Date.now() - start}ms`);
}

main().catch(console.error);
