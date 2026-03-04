import { defineConfig } from 'tsup';

export default defineConfig([
  // CLI entry point
  {
    entry: ['src/cli/index.ts'],
    format: ['esm'],
    target: 'node18',
    outDir: 'dist/cli',
    splitting: false,
    sourcemap: false,
    clean: true,
    dts: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
    noExternal: [],
    external: [
      '@slack/bolt',
      'discord.js',
      'node-pty',
    ],
  },
  // MCP memory server
  {
    entry: ['src/mcp/memory-server.ts'],
    format: ['esm'],
    target: 'node18',
    outDir: 'dist/mcp',
    splitting: false,
    sourcemap: false,
    clean: true,
    dts: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
    noExternal: [],
    external: [
      '@lancedb/lancedb',
      '@modelcontextprotocol/sdk',
    ],
  },
]);
