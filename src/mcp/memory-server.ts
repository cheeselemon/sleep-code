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

// ── Main ────────────────────────────────────────────────────

async function main() {
  // Initialize services (shared singletons)
  const embeddingProvider = new OllamaEmbeddingProvider();
  const embeddingService = new EmbeddingService(embeddingProvider);
  await embeddingService.initialize();

  const memoryService = new MemoryService(embeddingService);
  await memoryService.initialize();

  // ── HTTP Transport (stateless: new server per request) ──

  const PORT = Number(process.env.MCP_PORT) || 24242;

  createServer(async (req, res) => {
    const server = createMcpServerWithTools(memoryService);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(PORT, '127.0.0.1', () => {
    console.error(`sleep-code-memory MCP server listening on http://127.0.0.1:${PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
