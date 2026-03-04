import {
  OllamaEmbeddingProvider,
  EmbeddingService,
  MemoryService,
  OllamaChatProvider,
  ChatService,
  DistillService,
} from '../memory/index.js';

// ── Helpers ──────────────────────────────────────────────────

async function createServices() {
  const embeddingProvider = new OllamaEmbeddingProvider();
  const embeddingService = new EmbeddingService(embeddingProvider);
  await embeddingService.initialize();

  const memoryService = new MemoryService(embeddingService);
  await memoryService.initialize();

  return { embeddingService, memoryService };
}

async function createDistillService() {
  const chatProvider = new OllamaChatProvider();  // qwen3:4b
  const chatService = new ChatService(chatProvider);
  await chatService.initialize();
  return new DistillService(chatService);
}

// ── Commands ─────────────────────────────────────────────────

async function memorySearch(query: string, project?: string) {
  const { memoryService } = await createServices();

  console.log(`Searching for: "${query}"${project ? ` (project: ${project})` : ''}...\n`);
  const results = await memoryService.search(query, { project, limit: 10 });

  if (results.length === 0) {
    console.log('No memories found.');
    memoryService.shutdown();
    return;
  }

  for (const r of results) {
    console.log(`[${r.kind}] (score: ${r.score.toFixed(3)}, priority: ${r.priority}, speaker: ${r.speaker})`);
    console.log(`  ${r.text}`);
    if (r.topicKey) console.log(`  topic: ${r.topicKey}`);
    console.log(`  created: ${r.createdAt}\n`);
  }

  memoryService.shutdown();
}

async function memoryStore(text: string, project: string, kind: string) {
  const { memoryService } = await createServices();

  const id = await memoryService.store(text, {
    project,
    kind: kind as import('../memory/index.js').MemoryKind,
    source: 'user',
    speaker: 'user',
  });

  console.log(`Stored memory: ${id}`);
  memoryService.shutdown();
}

async function memoryStats(project?: string) {
  const { memoryService } = await createServices();

  if (project) {
    const count = await memoryService.countByProject(project);
    console.log(`Project "${project}": ${count} memories`);
  } else {
    console.log('Usage: sleep-code memory stats <project>');
  }

  memoryService.shutdown();
}

async function memoryDistillTest() {
  const distill = await createDistillService();

  const tests = [
    {
      label: 'Test 1: Decision message (with context)',
      context: [
        { speaker: 'claude', content: '벡터 DB를 LanceDB로 결정할까요?' },
        { speaker: 'user (SnoopDuck)', content: '로컬에서 돌릴 수 있는거 맞지?' },
        { speaker: 'claude', content: '네, 서버 없이 임베디드로 돌아갑니다.' },
      ],
      message: { speaker: 'user (SnoopDuck)', content: 'ㅇㅇ 그걸로 하자', timestamp: new Date().toISOString() },
      expect: { shouldStore: true, kind: 'decision' },
    },
    {
      label: 'Test 2: Casual message (with casual context)',
      context: [
        { speaker: 'user (SnoopDuck)', content: '밥 먹었어?' },
        { speaker: 'claude', content: '저는 AI라 밥을 안 먹어요 ㅋㅋ' },
      ],
      message: { speaker: 'user (SnoopDuck)', content: 'ㅋㅋ 밥먹고올게', timestamp: new Date().toISOString() },
      expect: { shouldStore: false },
    },
    {
      label: 'Test 3: Strong preference',
      context: [
        { speaker: 'claude', content: 'API 비용에 대해 어떻게 생각하세요?' },
      ],
      message: { speaker: 'user (SnoopDuck)', content: 'API 비용은 절대 쓰고 싶지 않아. Pro 구독으로만 해결하자.', timestamp: new Date().toISOString() },
      expect: { shouldStore: true, kind: 'decision' },
    },
    {
      label: 'Test 4: Contextual "ㅇㅇ" (casual context → should skip)',
      context: [
        { speaker: 'claude', content: '밥 드셨어요?' },
      ],
      message: { speaker: 'user (SnoopDuck)', content: 'ㅇㅇ', timestamp: new Date().toISOString() },
      expect: { shouldStore: false },
    },
  ];

  console.log(`Running ${tests.length} distill tests with qwen3:4b...\n`);

  for (const test of tests) {
    const start = Date.now();
    const result = await distill.distill({
      message: test.message,
      context: test.context,
    });
    const elapsed = Date.now() - start;

    const pass =
      result.shouldStore === test.expect.shouldStore &&
      (!test.expect.kind || result.kind === test.expect.kind);

    console.log(`${pass ? '✓' : '✗'} ${test.label} (${elapsed}ms)`);
    console.log(`  Expected: shouldStore=${test.expect.shouldStore}${test.expect.kind ? `, kind=${test.expect.kind}` : ''}`);
    console.log(`  Got:      shouldStore=${result.shouldStore}, kind=${result.kind}, priority=${result.priority}`);
    if (result.shouldStore) {
      console.log(`  Distilled: "${result.distilled}"`);
      console.log(`  Topic: ${result.topicKey}`);
    }
    console.log();
  }
}

// ── Entry ────────────────────────────────────────────────────

export async function memoryCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'search': {
      const query = args[1];
      if (!query) {
        console.error('Usage: sleep-code memory search <query> [--project <name>]');
        process.exit(1);
      }
      const projectIdx = args.indexOf('--project');
      const project = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
      await memorySearch(query, project);
      break;
    }

    case 'store': {
      const text = args[1];
      if (!text) {
        console.error('Usage: sleep-code memory store <text> [--project <name>] [--kind <kind>]');
        process.exit(1);
      }
      const pIdx = args.indexOf('--project');
      const kIdx = args.indexOf('--kind');
      await memoryStore(
        text,
        pIdx !== -1 ? args[pIdx + 1] : 'default',
        kIdx !== -1 ? args[kIdx + 1] : 'fact',
      );
      break;
    }

    case 'stats': {
      await memoryStats(args[1]);
      break;
    }

    case 'distill-test': {
      await memoryDistillTest();
      break;
    }

    default: {
      console.log(`
Memory commands:
  memory search <query> [--project <name>]                 Search memories
  memory store <text> [--project <name>] [--kind <kind>]   Store a memory
  memory stats <project>                                    Show memory stats
  memory distill-test                                       Test distill with qwen3:4b

Kinds: fact, task, observation, proposal, feedback, decision, dialog_summary
`);
      break;
    }
  }
}
