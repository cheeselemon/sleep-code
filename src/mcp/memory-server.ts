/**
 * MCP Memory Server for Sleep Code (HTTP transport)
 *
 * Exposes LanceDB memory store as MCP tools:
 * - sc_memory_search: semantic search
 * - sc_memory_list: list by project
 * - sc_memory_store: manual store
 */

import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  OllamaEmbeddingProvider,
  EmbeddingService,
  MemoryService,
  type MemoryKind,
  type MemorySpeaker,
  type MemorySearchResult,
  type MemoryUnit,
} from '../memory/index.js';

// ── Helpers ─────────────────────────────────────────────────

function formatSearchResult(r: MemorySearchResult): string {
  const score = (r.score * 100).toFixed(1);
  const meta = [
    r.kind,
    `score:${score}%`,
    `priority:${r.priority}`,
    r.speaker !== 'system' ? `speaker:${r.speaker}` : '',
    r.topicKey ? `topic:${r.topicKey}` : '',
    `project:${r.project}`,
    r.status === 'superseded' ? 'SUPERSEDED' : '',
    r.supersedesId ? `supersedes:${r.supersedesId.slice(0, 8)}` : '',
  ].filter(Boolean).join(', ');
  return `[${meta}] id:${r.id}\n  ${r.text}\n  (${r.createdAt})`;
}

function formatMemoryUnit(m: MemoryUnit): string {
  const meta = [
    m.kind,
    `priority:${m.priority}`,
    m.speaker !== 'system' ? `speaker:${m.speaker}` : '',
    m.topicKey ? `topic:${m.topicKey}` : '',
    m.status === 'superseded' ? 'SUPERSEDED' : '',
    m.supersedesId ? `supersedes:${m.supersedesId.slice(0, 8)}` : '',
  ].filter(Boolean).join(', ');
  return `[${meta}] id:${m.id}\n  ${m.text}\n  (${m.createdAt})`;
}

// ── Server Factory ──────────────────────────────────────────

const VALID_KINDS: MemoryKind[] = ['fact', 'task', 'observation', 'proposal', 'feedback', 'dialog_summary', 'decision'];
const VALID_SPEAKERS: MemorySpeaker[] = ['user', 'claude', 'codex', 'system'];

function createMcpServerWithTools(memoryService: MemoryService): McpServer {
  const server = new McpServer({
    name: 'sleep-code-memory',
    version: '1.0.0',
  });

  server.registerTool(
    'sc_memory_search',
    {
      description: 'Semantic search over stored memories. Use when you need to recall past decisions, facts, preferences, or context from previous conversations.',
      inputSchema: z.object({
        query: z.string().describe('Search query (natural language)'),
        project: z.string().optional().describe('Filter by project name (e.g. "sleep-code", "cpik-inc")'),
        limit: z.number().optional().describe('Max results (default 5)'),
        includeSuperseded: z.boolean().optional().describe('Include superseded memories (default false)'),
      }),
    },
    async ({ query, project, limit, includeSuperseded }) => {
      const results = await memoryService.search(query, {
        project,
        limit: limit ?? 5,
        includeSuperseded: includeSuperseded ?? false,
      });

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }

      const text = results.map(formatSearchResult).join('\n\n');
      return { content: [{ type: 'text', text: `Found ${results.length} memories:\n\n${text}` }] };
    },
  );

  server.registerTool(
    'sc_memory_list',
    {
      description: 'List recent memories for a project. Use to get an overview of what has been remembered for a specific project.',
      inputSchema: z.object({
        project: z.string().describe('Project name (e.g. "sleep-code", "cpik-inc")'),
        limit: z.number().optional().describe('Max results (default 20)'),
        includeSuperseded: z.boolean().optional().describe('Include superseded memories (default false)'),
      }),
    },
    async ({ project, limit, includeSuperseded }) => {
      const results = await memoryService.getByProject(project, {
        limit: limit ?? 20,
        includeSuperseded: includeSuperseded ?? false,
      });

      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No memories found for project "${project}".` }] };
      }

      const text = results.map(formatMemoryUnit).join('\n\n');
      return { content: [{ type: 'text', text: `${results.length} memories for "${project}":\n\n${text}` }] };
    },
  );

  server.registerTool(
    'sc_memory_store',
    {
      description: 'Manually store a memory. Use when you learn something important that should be remembered long-term (decisions, preferences, facts).',
      inputSchema: z.object({
        text: z.string().describe('The memory content to store'),
        project: z.string().describe('Project name'),
        kind: z.enum(VALID_KINDS as [string, ...string[]]).describe('Memory type'),
        speaker: z.enum(VALID_SPEAKERS as [string, ...string[]]).optional().describe('Who said it (default: system)'),
        priority: z.number().min(0).max(10).optional().describe('Importance 0-10 (default: 5)'),
        topicKey: z.string().optional().describe('Topic tag in English (e.g. "vector-db", "refund-logic")'),
      }),
    },
    async ({ text, project, kind, speaker, priority, topicKey }) => {
      const id = await memoryService.storeIfNew(text, {
        project,
        kind: kind as MemoryKind,
        source: 'user',
        speaker: (speaker as MemorySpeaker) ?? 'system',
        priority: priority ?? 5,
        topicKey,
      });

      if (id) {
        return { content: [{ type: 'text', text: `Stored memory: ${id}` }] };
      }
      return { content: [{ type: 'text', text: 'Similar memory already exists (reinforced priority).' }] };
    },
  );

  server.registerTool(
    'sc_memory_update',
    {
      description: 'Update fields of an existing memory. Use to correct text, change priority, fix speaker attribution, or update topicKey.',
      inputSchema: z.object({
        id: z.string().describe('Memory ID to update'),
        text: z.string().optional().describe('New text content'),
        kind: z.enum(VALID_KINDS as [string, ...string[]]).optional().describe('New memory type'),
        speaker: z.enum(VALID_SPEAKERS as [string, ...string[]]).optional().describe('New speaker'),
        priority: z.number().min(0).max(10).optional().describe('New priority 0-10'),
        topicKey: z.string().optional().describe('New topic tag'),
      }),
    },
    async ({ id, text, kind, speaker, priority, topicKey }) => {
      const fields: Record<string, unknown> = {};
      if (text !== undefined) fields.text = text;
      if (kind !== undefined) fields.kind = kind;
      if (speaker !== undefined) fields.speaker = speaker;
      if (priority !== undefined) fields.priority = priority;
      if (topicKey !== undefined) fields.topicKey = topicKey;

      if (Object.keys(fields).length === 0) {
        return { content: [{ type: 'text', text: 'No fields to update. Provide at least one of: text, kind, speaker, priority, topicKey.' }] };
      }

      await memoryService.updateFields(id, fields as Parameters<typeof memoryService.updateFields>[1]);
      return { content: [{ type: 'text', text: `Updated memory ${id}: ${Object.keys(fields).join(', ')}` }] };
    },
  );

  server.registerTool(
    'sc_memory_delete',
    {
      description: 'Delete a memory by ID. Use when a memory is wrong, outdated, or no longer relevant.',
      inputSchema: z.object({
        id: z.string().describe('Memory ID to delete'),
      }),
    },
    async ({ id }) => {
      await memoryService.remove(id);
      return { content: [{ type: 'text', text: `Deleted memory: ${id}` }] };
    },
  );

  server.registerTool(
    'sc_memory_supersede',
    {
      description: 'Mark an old memory as superseded by a new one. Use when new info replaces old info (e.g., time change, name correction). The old memory is preserved but hidden from default search.',
      inputSchema: z.object({
        oldId: z.string().describe('ID of the old memory to supersede'),
        newId: z.string().describe('ID of the new memory that replaces it'),
      }),
    },
    async ({ oldId, newId }) => {
      await memoryService.markSuperseded(oldId, newId);
      return { content: [{ type: 'text', text: `Superseded: ${oldId} → ${newId}` }] };
    },
  );

  return server;
}

// ── Internal API Router ─────────────────────────────────────

type InternalHandler = (body: any, memoryService: MemoryService) => Promise<unknown>;

const WRITE_HANDLERS: Record<string, InternalHandler> = {
  '/internal/store': async (body, ms) => {
    const id = await ms.store(body.text, body.options);
    return { id };
  },
  '/internal/storeIfNew': async (body, ms) => {
    const id = await ms.storeIfNew(body.text, body.options);
    return { id };
  },
  '/internal/markSuperseded': async (body, ms) => {
    await ms.markSuperseded(body.oldId, body.newId);
  },
  '/internal/updateStatus': async (body, ms) => {
    await ms.updateStatus(body.id, body.status);
  },
  '/internal/remove': async (body, ms) => {
    await ms.remove(body.id);
  },
  '/internal/updateFields': async (body, ms) => {
    await ms.updateFields(body.id, body.fields);
  },
  '/internal/undoSupersede': async (body, ms) => {
    await ms.undoSupersede(body.id);
  },
  '/internal/snooze': async (body, ms) => {
    await ms.snooze(body.id, body.until);
  },
  '/internal/reinforcePriority': async (body, ms) => {
    await ms.reinforcePriority(body.id, body.currentPriority);
  },
};

const QUERY_OPS: Record<string, InternalHandler> = {
  search: async (body, ms) => ms.search(body.query, body),
  getByProject: async (body, ms) => ms.getByProject(body.project, body),
  getAllWithVectors: async (body, ms) => ms.getAllWithVectors(body.project),
  listProjects: async (_body, ms) => ms.listProjects(),
  getTopicKeys: async (body, ms) => ms.getTopicKeys(body.project),
  searchByVector: async (body, ms) => ms.searchByVector(body.vector, body),
  findSupersedeCandidate: async (body, ms) => {
    const { vector, ...options } = body;
    return ms.findSupersedeCandidate(vector, options);
  },
  embedForSearch: async (body, ms) => ms.embedForSearch(body.text),
  countByProject: async (body, ms) => ms.countByProject(body.project),
};

function parseBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleInternalRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  memoryService: MemoryService,
): Promise<boolean> {
  const url = req.url || '';

  // Health check (GET)
  if (url === '/internal/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return true;
  }

  // Not an internal route — let MCP handle it
  if (!url.startsWith('/internal/')) {
    return false;
  }

  // Internal routes only accept POST (except /health which is GET above)
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Method ${req.method} not allowed on ${url}` }));
    return true;
  }

  try {
    const body = await parseBody(req);

    // Write endpoints
    const writeHandler = WRITE_HANDLERS[url];
    if (writeHandler) {
      const result = await writeHandler(body, memoryService);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result ?? { ok: true }));
      return true;
    }

    // Query endpoint
    if (url === '/internal/query') {
      const { op, ...params } = body;
      const queryHandler = QUERY_OPS[op];
      if (!queryHandler) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown query op: ${op}` }));
        return true;
      }
      const result = await queryHandler(params, memoryService);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return true;
    }

    // Composite endpoints (stubs for future steps)
    if (url === '/internal/distill-batch' || url === '/internal/consolidate' || url === '/internal/generate-digest') {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not implemented yet' }));
      return true;
    }

    // Unknown internal route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown internal route: ${url}` }));
    return true;
  } catch (err: any) {
    const status = err.message === 'Invalid JSON' ? 400 : 500;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || 'Internal server error' }));
    return true;
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  // Initialize services (shared singletons)
  const embeddingProvider = new OllamaEmbeddingProvider();
  const embeddingService = new EmbeddingService(embeddingProvider);
  await embeddingService.initialize();

  const memoryService = new MemoryService(embeddingService);
  await memoryService.initialize();

  // ── HTTP Server ──
  // Routes:
  //   /internal/*  → Internal API (Memory Authority)
  //   everything else → MCP transport

  const PORT = Number(process.env.MCP_PORT) || 24242;

  createServer(async (req, res) => {
    // Internal API routes (write/read/health)
    const handled = await handleInternalRequest(req, res, memoryService);
    if (handled) return;

    // MCP transport (all other routes)
    const server = createMcpServerWithTools(memoryService);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(PORT, '127.0.0.1', () => {
    console.error(`sleep-code-memory MCP server listening on http://127.0.0.1:${PORT}/mcp`);
    console.error(`  Internal API: http://127.0.0.1:${PORT}/internal/*`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
