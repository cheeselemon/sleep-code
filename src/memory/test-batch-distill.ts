#!/usr/bin/env tsx
/**
 * Test: Batch Distill Pipeline
 *
 * Tests the full flow:
 * 1. memory-config load
 * 2. ClaudeSdkChatProvider session open + chat
 * 3. DistillService.distillBatch()
 * 4. MemoryService store (LanceDB)
 *
 * Run: npx tsx src/memory/test-batch-distill.ts
 */

import { loadMemoryConfig, getMemoryConfig } from './memory-config.js';
import { ClaudeSdkChatProvider, ChatService } from './chat-provider.js';
import { DistillService, type BatchDistillItem } from './distill-service.js';
import { OllamaEmbeddingProvider, EmbeddingService } from './embedding-provider.js';
import { MemoryService } from './memory-service.js';

async function main() {
  console.log('=== Test: Batch Distill Pipeline ===\n');

  // Step 1: Config
  console.log('1. Loading memory config...');
  const config = await loadMemoryConfig();
  console.log(`   distill.model: ${config.distill.model}`);
  console.log(`   distill.batchMaxMessages: ${config.distill.batchMaxMessages}`);
  console.log('   OK\n');

  // Step 2: SDK Chat Provider
  console.log('2. Testing ClaudeSdkChatProvider...');
  const chatProvider = new ClaudeSdkChatProvider({
    model: config.distill.model,
  });

  console.log('   Opening SDK session...');
  const chatService = new ChatService(chatProvider);

  // Quick test: send a simple message
  const testResponse = await chatService.chat([
    { role: 'system', content: 'You are a test assistant. Reply with exactly: {"status":"ok"}' },
    { role: 'user', content: 'ping' },
  ]);
  console.log(`   Response: ${testResponse.slice(0, 100)}`);
  console.log('   OK\n');

  // Step 3: Batch Distill
  console.log('3. Testing distillBatch()...');
  const distillService = new DistillService(chatService);

  const testItems: BatchDistillItem[] = [
    {
      id: 0,
      message: { speaker: 'SnoopDuck (user)', content: 'LanceDB로 벡터DB 확정하자', timestamp: new Date().toISOString() },
      context: [
        { speaker: 'Claude (claude)', content: '벡터DB 후보로 LanceDB, Chroma, Qdrant가 있습니다' },
        { speaker: 'SnoopDuck (user)', content: '비교해줘' },
      ],
    },
    {
      id: 1,
      message: { speaker: 'Claude (claude)', content: '확인했습니다. 진행하겠습니다.', timestamp: new Date().toISOString() },
      context: [
        { speaker: 'SnoopDuck (user)', content: 'LanceDB로 벡터DB 확정하자' },
      ],
    },
    {
      id: 2,
      message: { speaker: 'SnoopDuck (user)', content: 'ㅇㅇ', timestamp: new Date().toISOString() },
      context: [
        { speaker: 'SnoopDuck (user)', content: '오늘 점심 뭐 먹을까' },
        { speaker: 'Claude (claude)', content: '김치찌개 어떠세요?' },
      ],
    },
  ];

  const batchResults = await distillService.distillBatch(testItems);

  for (const br of batchResults) {
    const r = br.result;
    const status = r.shouldStore ? '🟢 STORE' : '⏭️ SKIP';
    console.log(`   [${br.id}] ${status} ${r.shouldStore ? `[${r.kind} p:${r.priority}] "${r.distilled}"` : ''}`);
  }
  console.log('   OK\n');

  // Step 4: LanceDB Store
  console.log('4. Testing LanceDB store...');
  const embeddingProvider = new OllamaEmbeddingProvider();
  const embeddingService = new EmbeddingService(embeddingProvider);
  await embeddingService.initialize();
  const memoryService = new MemoryService(embeddingService);
  await memoryService.initialize();

  const storable = batchResults.filter(br => br.result.shouldStore);
  for (const br of storable) {
    const r = br.result;
    const id = await memoryService.storeIfNew(r.distilled, {
      project: 'test-batch',
      kind: r.kind as any,
      source: 'session',
      speaker: r.speaker as any ?? 'user',
      priority: r.priority,
      topicKey: r.topicKey,
    });
    console.log(`   Stored: ${id ? id.slice(0, 8) : 'duplicate'} → "${r.distilled}"`);
  }
  console.log('   OK\n');

  // Step 5: Verify search
  console.log('5. Verifying search...');
  const results = await memoryService.search('벡터DB', { project: 'test-batch', limit: 3 });
  for (const sr of results) {
    console.log(`   [${sr.score.toFixed(2)}] ${sr.text}`);
  }
  console.log('   OK\n');

  // Cleanup
  await chatProvider.closeSession();

  console.log('=== All tests passed ===');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
