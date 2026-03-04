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
  ].filter(Boolean).join(', ');
  return `[${meta}]\n  ${r.text}\n  (${r.createdAt})`;
}

function formatMemoryUnit(m: MemoryUnit): string {
  const meta = [
    m.kind,
    `priority:${m.priority}`,
    m.speaker !== 'system' ? `speaker:${m.speaker}` : '',
    m.topicKey ? `topic:${m.topicKey}` : '',
  ].filter(Boolean).join(', ');
  return `[${meta}]\n  ${m.text}\n  (${m.createdAt})`;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  // Initialize services
  const embeddingProvider = new OllamaEmbeddingProvider();
  const embeddingService = new EmbeddingService(embeddingProvider);
  await embeddingService.initialize();

  const memoryService = new MemoryService(embeddingService);
  await memoryService.initialize();

  // Create MCP server
  const server = new McpServer({
    name: 'sleep-code-memory',
    version: '1.0.0',
  });

  // ── sc_memory_search ────────────────────────────────────

  server.registerTool(
    'sc_memory_search',
    {
      description: 'Semantic search over stored memories. Use when you need to recall past decisions, facts, preferences, or context from previous conversations.',
      inputSchema: z.object({
        query: z.string().describe('Search query (natural language)'),
        project: z.string().optional().describe('Filter by project name (e.g. "sleep-code", "cpik-inc")'),
        limit: z.number().optional().describe('Max results (default 5)'),
      }),
    },
    async ({ query, project, limit }) => {
      const results = await memoryService.search(query, {
        project,
        limit: limit ?? 5,
      });

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }

      const text = results.map(formatSearchResult).join('\n\n');
      return { content: [{ type: 'text', text: `Found ${results.length} memories:\n\n${text}` }] };
    },
  );

  // ── sc_memory_list ──────────────────────────────────────

  server.registerTool(
    'sc_memory_list',
    {
      description: 'List recent memories for a project. Use to get an overview of what has been remembered for a specific project.',
      inputSchema: z.object({
        project: z.string().describe('Project name (e.g. "sleep-code", "cpik-inc")'),
        limit: z.number().optional().describe('Max results (default 20)'),
      }),
    },
    async ({ project, limit }) => {
      const results = await memoryService.getByProject(project, {
        limit: limit ?? 20,
      });

      if (results.length === 0) {
        return { content: [{ type: 'text', text: `No memories found for project "${project}".` }] };
      }

      const text = results.map(formatMemoryUnit).join('\n\n');
      return { content: [{ type: 'text', text: `${results.length} memories for "${project}":\n\n${text}` }] };
    },
  );

  // ── sc_memory_store ─────────────────────────────────────

  const VALID_KINDS: MemoryKind[] = ['fact', 'task', 'observation', 'proposal', 'feedback', 'dialog_summary', 'decision'];
  const VALID_SPEAKERS: MemorySpeaker[] = ['user', 'claude', 'codex', 'system'];

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

  // ── HTTP Transport ─────────────────────────────────────

  const PORT = Number(process.env.MCP_PORT) || 24242;

  createServer(async (req, res) => {
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
