import {
  OllamaChatProvider,
  ChatService,
  DistillService,
  ConsolidationService,
} from '../memory/index.js';
import { MemoryAuthorityClient } from '../memory/memory-authority-client.js';

// ── Helpers ──────────────────────────────────────────────────

function isAuthorityUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('ECONNREFUSED')
    || message.includes('ETIMEDOUT')
    || message.includes('ECONNRESET')
    || message.includes('UND_ERR_SOCKET')
    || message.includes('AbortError')
    || message.includes('fetch failed')
  );
}

async function createMemoryClient() {
  const memoryClient = new MemoryAuthorityClient();
  const healthy = await memoryClient.healthCheck();
  if (!healthy) {
    throw new Error(
      'Memory Authority server is unreachable at http://127.0.0.1:24242. Start the MCP server before using memory commands.',
    );
  }

  await memoryClient.initialize();
  return memoryClient;
}

async function createDistillService() {
  const chatProvider = new OllamaChatProvider();  // qwen2.5:7b
  const chatService = new ChatService(chatProvider);
  await chatService.initialize();
  return new DistillService(chatService);
}

// ── Commands ─────────────────────────────────────────────────

async function memorySearch(query: string, project?: string) {
  const memoryClient = await createMemoryClient();

  console.log(`Searching for: "${query}"${project ? ` (project: ${project})` : ''}...\n`);
  const results = await memoryClient.search(query, { project, limit: 10 });

  if (results.length === 0) {
    console.log('No memories found.');
    memoryClient.shutdown();
    return;
  }

  for (const r of results) {
    console.log(`[${r.kind}] (score: ${r.score.toFixed(3)}, priority: ${r.priority}, speaker: ${r.speaker})`);
    console.log(`  ${r.text}`);
    if (r.topicKey) console.log(`  topic: ${r.topicKey}`);
    console.log(`  id: ${r.id}  created: ${r.createdAt}\n`);
  }

  memoryClient.shutdown();
}

async function memoryStore(text: string, project: string, kind: string) {
  const memoryClient = await createMemoryClient();

  const id = await memoryClient.store(text, {
    project,
    kind: kind as import('../memory/index.js').MemoryKind,
    source: 'user',
    speaker: 'user',
  });

  console.log(`Stored memory: ${id}`);
  memoryClient.shutdown();
}

async function memoryStats(project?: string) {
  const memoryClient = await createMemoryClient();

  if (project) {
    const count = await memoryClient.countByProject(project);
    console.log(`Project "${project}": ${count} memories`);
  } else {
    console.log('Usage: sleep-code memory stats <project>');
  }

  memoryClient.shutdown();
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

async function memoryDelete(id: string) {
  const memoryClient = await createMemoryClient();

  // Verify it exists first
  const projects = await memoryClient.listProjects();
  let found = false;
  for (const project of projects) {
    const memories = await memoryClient.getByProject(project, { limit: 1000 });
    const match = memories.find((m) => m.id === id);
    if (match) {
      console.log(`Found: [${match.kind}] "${match.text}"`);
      console.log(`  project: ${match.project}, priority: ${match.priority}`);
      await memoryClient.remove(id);
      console.log(`Deleted: ${id}`);
      found = true;
      break;
    }
  }

  if (!found) {
    console.error(`Memory not found: ${id}`);
  }

  memoryClient.shutdown();
}

async function memoryConsolidate(project: string | undefined, dryRun: boolean) {
  const memoryClient = await createMemoryClient();
  const consolidation = new ConsolidationService(memoryClient);

  if (dryRun) {
    console.log('=== DRY RUN (no changes will be made) ===\n');
  }

  const report = await consolidation.consolidate({ project, dryRun });

  for (const pr of report.projectReports) {
    console.log(`\nProject: ${pr.project} (${pr.beforeCount} memories)`);

    if (pr.mergeDetails.length > 0) {
      console.log(`  Merges: ${pr.merged}`);
      for (const m of pr.mergeDetails) {
        console.log(`    [merge] sim=${(m.similarity * 100).toFixed(1)}%`);
        console.log(`      keep:   "${m.keptText.slice(0, 80)}"`);
        console.log(`      delete: "${m.deletedText.slice(0, 80)}"`);
      }
    }

    if (pr.cleanDetails.length > 0) {
      console.log(`  Cleanup: ${pr.cleaned}`);
      for (const c of pr.cleanDetails) {
        console.log(`    [${c.reason}] ${c.kind}, priority=${c.priority}, speaker=${c.speaker}`);
        console.log(`      "${c.text.slice(0, 80)}"`);
      }
    }

    if (pr.merged === 0 && pr.cleaned === 0) {
      console.log('  Nothing to consolidate.');
    }

    console.log(`  Result: ${pr.beforeCount} → ${pr.afterCount}`);
  }

  console.log(`\n--- Summary ---`);
  console.log(`Merged: ${report.totalMerged}, Cleaned: ${report.totalCleaned}, Remaining: ${report.totalRemaining}`);

  if (dryRun && (report.totalMerged > 0 || report.totalCleaned > 0)) {
    console.log('\nRe-run without --dry-run to apply changes.');
  }

  memoryClient.shutdown();
}

async function memoryGraph(project: string | undefined, threshold: number) {
  const memoryClient = await createMemoryClient();

  const projects = project ? [project] : await memoryClient.listProjects();
  console.log(`Loading memories from ${projects.length} project(s)...`);

  // Load all memories with vectors
  interface NodeData {
    id: string; text: string; project: string; kind: string;
    speaker: string; priority: number; topicKey: string; createdAt: string;
    vector: number[];
  }
  const allNodes: NodeData[] = [];

  for (const p of projects) {
    const records = await memoryClient.getAllWithVectors(p);
    for (const r of records) {
      allNodes.push({
        id: r.id, text: r.text, project: r.project, kind: r.kind,
        speaker: r.speaker, priority: r.priority,
        topicKey: r.topicKey ?? '', createdAt: r.createdAt, vector: r.vector,
      });
    }
  }

  console.log(`${allNodes.length} memories loaded. Computing similarities...`);

  // Cosine similarity
  function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  // Compute edges
  const edges: { source: string; target: string; similarity: number }[] = [];
  for (let i = 0; i < allNodes.length; i++) {
    for (let j = i + 1; j < allNodes.length; j++) {
      const sim = cosine(allNodes[i].vector, allNodes[j].vector);
      if (sim >= threshold) {
        edges.push({ source: allNodes[i].id, target: allNodes[j].id, similarity: sim });
      }
    }
  }

  console.log(`${edges.length} edges (threshold: ${threshold})`);

  // Build graph JSON (strip vectors)
  const nodes = allNodes.map(({ vector: _, ...rest }) => rest);
  const graphData = JSON.stringify({ nodes, edges });

  const PROJECT_COLORS: Record<string, string> = {
    'sleep-code': '#4A90D9',
    'cpik-inc': '#50C878',
    'tpt-strategy': '#F5A623',
    'personal-memory': '#9B59B6',
  };

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Memory Graph</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a2e; overflow: hidden; font-family: -apple-system, sans-serif; }
  svg { width: 100vw; height: 100vh; }
  .tooltip {
    position: absolute; background: #16213e; color: #e8e8e8; padding: 10px 14px;
    border-radius: 8px; font-size: 13px; max-width: 360px; pointer-events: none;
    border: 1px solid #334; line-height: 1.5; display: none; z-index: 10;
  }
  .tooltip .kind { color: #7ec8e3; font-weight: 600; }
  .tooltip .project { color: #ccc; font-size: 11px; }
  .legend {
    position: fixed; top: 16px; left: 16px; background: #16213e; padding: 12px 16px;
    border-radius: 8px; border: 1px solid #334; color: #ccc; font-size: 12px;
  }
  .legend-item { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
  .stats {
    position: fixed; bottom: 16px; left: 16px; color: #666; font-size: 11px;
  }
</style>
</head><body>
<div class="tooltip" id="tooltip"></div>
<div class="legend" id="legend"></div>
<div class="stats" id="stats"></div>
<svg id="graph"></svg>
<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const data = ${graphData};
const colors = ${JSON.stringify(PROJECT_COLORS)};
const defaultColor = '#888';

// Legend
const projectSet = [...new Set(data.nodes.map(n => n.project))];
document.getElementById('legend').innerHTML =
  '<div style="font-weight:600;margin-bottom:6px">Projects</div>' +
  projectSet.map(p =>
    '<div class="legend-item"><div class="legend-dot" style="background:' +
    (colors[p]||defaultColor) + '"></div>' + p + '</div>'
  ).join('');

document.getElementById('stats').textContent =
  data.nodes.length + ' memories, ' + data.edges.length + ' connections';

const width = window.innerWidth, height = window.innerHeight;
const svg = d3.select('#graph').attr('viewBox', [0, 0, width, height]);
const g = svg.append('g');

// Zoom
svg.call(d3.zoom().scaleExtent([0.1, 8]).on('zoom', e => g.attr('transform', e.transform)));

const sim = d3.forceSimulation(data.nodes)
  .force('link', d3.forceLink(data.edges).id(d => d.id).distance(80).strength(d => d.similarity * 0.3))
  .force('charge', d3.forceManyBody().strength(-120))
  .force('center', d3.forceCenter(width/2, height/2))
  .force('collision', d3.forceCollide().radius(d => 4 + d.priority * 1.5));

const link = g.append('g').selectAll('line').data(data.edges).join('line')
  .attr('stroke', '#334').attr('stroke-opacity', 0.5)
  .attr('stroke-width', d => 0.5 + (d.similarity - 0.7) * 5);

const node = g.append('g').selectAll('circle').data(data.nodes).join('circle')
  .attr('r', d => 4 + d.priority * 1.2)
  .attr('fill', d => colors[d.project] || defaultColor)
  .attr('stroke', '#fff').attr('stroke-width', 0.5)
  .attr('cursor', 'grab')
  .call(d3.drag()
    .on('start', (e,d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx=d.x; d.fy=d.y; })
    .on('drag', (e,d) => { d.fx=e.x; d.fy=e.y; })
    .on('end', (e,d) => { if (!e.active) sim.alphaTarget(0); d.fx=null; d.fy=null; })
  );

const label = g.append('g').selectAll('text').data(data.nodes).join('text')
  .text(d => d.topicKey || d.text.slice(0, 15))
  .attr('font-size', 9).attr('fill', '#888').attr('dx', 10).attr('dy', 3)
  .style('pointer-events', 'none');

// Tooltip
const tooltip = document.getElementById('tooltip');
node.on('mouseover', (e, d) => {
  tooltip.style.display = 'block';
  tooltip.innerHTML = '<span class="kind">[' + d.kind + ']</span> priority: ' + d.priority +
    '<br>' + d.text +
    '<br><span class="project">' + d.project + ' | ' + d.speaker + ' | ' + d.createdAt.slice(0,10) + '</span>';
}).on('mousemove', e => {
  tooltip.style.left = (e.pageX + 14) + 'px';
  tooltip.style.top = (e.pageY - 14) + 'px';
}).on('mouseout', () => { tooltip.style.display = 'none'; });

sim.on('tick', () => {
  link.attr('x1',d=>d.source.x).attr('y1',d=>d.source.y).attr('x2',d=>d.target.x).attr('y2',d=>d.target.y);
  node.attr('cx',d=>d.x).attr('cy',d=>d.y);
  label.attr('x',d=>d.x).attr('y',d=>d.y);
});
</script></body></html>`;

  const { writeFileSync } = await import('fs');
  const outPath = '/tmp/sleep-code-memory-graph.html';
  writeFileSync(outPath, html);
  console.log(`Graph saved: ${outPath}`);

  // Open in browser
  const { exec } = await import('child_process');
  exec(`open "${outPath}"`);

  memoryClient.shutdown();
}

async function memoryRetag(project: string | undefined, dryRun: boolean) {
  const memoryClient = await createMemoryClient();
  const distill = await createDistillService();

  const projects = project ? [project] : await memoryClient.listProjects();

  let totalRetagged = 0;
  let totalSkipped = 0;

  for (const p of projects) {
    const memories = await memoryClient.getByProject(p, { limit: 1000 });
    if (memories.length === 0) continue;

    // Collect current topicKeys as reference
    const existingTopicKeys = [...new Set(
      memories.map(m => m.topicKey).filter((t): t is string => !!t && t.length > 0),
    )].sort();

    console.log(`\nProject: ${p} (${memories.length} memories, ${existingTopicKeys.length} unique topics)`);
    console.log(`  Existing topics: ${existingTopicKeys.join(', ')}`);

    for (const mem of memories) {
      // Re-distill just for topicKey using the memory text
      const result = await distill.distill({
        message: {
          speaker: mem.speaker,
          content: mem.text,
          timestamp: mem.createdAt,
        },
        context: [],
        existingTopicKeys,
      });

      if (!result.shouldStore || !result.topicKey) {
        totalSkipped++;
        continue;
      }

      const newTopic = result.topicKey;
      if (newTopic === mem.topicKey) {
        totalSkipped++;
        continue;
      }

      if (dryRun) {
        console.log(`  [retag] "${mem.text.slice(0, 60)}..."`);
        console.log(`    ${mem.topicKey || '(none)'} → ${newTopic}`);
      } else {
        await memoryClient.updateFields(mem.id, { topicKey: newTopic });
        console.log(`  [retag] ${mem.topicKey || '(none)'} → ${newTopic}: "${mem.text.slice(0, 50)}..."`);
      }

      // Add newly assigned topic to reference list for consistency
      if (!existingTopicKeys.includes(newTopic)) {
        existingTopicKeys.push(newTopic);
        existingTopicKeys.sort();
      }

      totalRetagged++;
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Retagged: ${totalRetagged}, Skipped: ${totalSkipped}`);
  if (dryRun && totalRetagged > 0) {
    console.log('\nRe-run without --dry-run to apply changes.');
  }

  memoryClient.shutdown();
}

async function memorySupersede(oldId: string, newId: string) {
  const memoryClient = await createMemoryClient();

  // Verify both exist
  const projects = await memoryClient.listProjects();
  let oldFound = false, newFound = false;
  for (const p of projects) {
    const memories = await memoryClient.getByProject(p, { limit: 1000, includeSuperseded: true });
    for (const m of memories) {
      if (m.id === oldId) { oldFound = true; console.log(`Old: [${m.kind}] "${m.text.slice(0, 80)}"`); }
      if (m.id === newId) { newFound = true; console.log(`New: [${m.kind}] "${m.text.slice(0, 80)}"`); }
    }
  }

  if (!oldFound || !newFound) {
    if (!oldFound) console.error(`Old memory not found: ${oldId}`);
    if (!newFound) console.error(`New memory not found: ${newId}`);
    memoryClient.shutdown();
    return;
  }

  await memoryClient.markSuperseded(oldId, newId);
  console.log(`Done: ${oldId} superseded by ${newId}`);
  memoryClient.shutdown();
}

async function memoryUnsupersede(id: string) {
  const memoryClient = await createMemoryClient();

  await memoryClient.undoSupersede(id);
  console.log(`Done: ${id} restored to open`);
  memoryClient.shutdown();
}

// ── Entry ────────────────────────────────────────────────────

export async function memoryCommand(args: string[]): Promise<void> {
  try {
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

      case 'delete': {
        const id = args[1];
        if (!id) {
          console.error('Usage: sleep-code memory delete <id>');
          process.exit(1);
        }
        await memoryDelete(id);
        break;
      }

      case 'consolidate': {
        const projectIdx = args.indexOf('--project');
        const project = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
        const dryRun = args.includes('--dry-run');
        await memoryConsolidate(project, dryRun);
        break;
      }

      case 'retag': {
        const projectIdx = args.indexOf('--project');
        const project = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
        const dryRun = args.includes('--dry-run');
        await memoryRetag(project, dryRun);
        break;
      }

      case 'supersede': {
        const oldId = args[1];
        const newId = args[2];
        if (!oldId || !newId) {
          console.error('Usage: sleep-code memory supersede <oldId> <newId>');
          process.exit(1);
        }
        await memorySupersede(oldId, newId);
        break;
      }

      case 'unsupersede': {
        const id = args[1];
        if (!id) {
          console.error('Usage: sleep-code memory unsupersede <id>');
          process.exit(1);
        }
        await memoryUnsupersede(id);
        break;
      }

      case 'graph': {
        const projectIdx = args.indexOf('--project');
        const project = projectIdx !== -1 ? args[projectIdx + 1] : undefined;
        const threshIdx = args.indexOf('--threshold');
        const threshold = threshIdx !== -1 ? parseFloat(args[threshIdx + 1]) : 0.7;
        await memoryGraph(project, threshold);
        break;
      }

      default: {
        console.log(`
Memory commands:
  memory search <query> [--project <name>]                 Search memories
  memory store <text> [--project <name>] [--kind <kind>]   Store a memory
  memory delete <id>                                        Delete a memory by ID
  memory supersede <oldId> <newId>                          Mark oldId as superseded by newId
  memory unsupersede <id>                                   Undo supersede, restore to open
  memory stats <project>                                    Show memory stats
  memory distill-test                                       Test distill with qwen2.5:7b
  memory consolidate [--project <name>] [--dry-run]        Consolidate memories
  memory retag [--project <name>] [--dry-run]              Re-tag topicKeys via LLM
  memory graph [--project <name>] [--threshold 0.7]        Visualize memory graph

Kinds: fact, task, observation, proposal, feedback, decision, dialog_summary
`);
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isAuthorityUnavailableError(err) || message.includes('Memory Authority server is unreachable')) {
      console.error(message);
      process.exit(1);
    }
    throw err;
  }
}
