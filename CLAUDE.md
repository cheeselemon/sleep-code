Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install`
- Use `bun run <script>` instead of `npm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Project: Snowfort

Remote access to local Claude Code sessions from mobile.

### Architecture
- **CLI**: `src/cli/` - Commands like `snowfort run`, `snowfort setup`
- **Daemon**: `src/daemon/` - Background service managing sessions and relay connection
- **Relay**: `src/relay/` - Cloud server routing traffic (separate deployment)

### Key Dependencies
- **AgentAPI**: HTTP wrapper for Claude Code (`go install github.com/coder/agentapi@latest`)
- **Bun.serve**: WebSocket server for relay

### Running
- `bun run src/cli/index.ts run -- claude` - Start a session
- `bun run src/daemon/index.ts` - Run the daemon
