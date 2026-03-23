import { homedir } from 'os';
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import * as readline from 'readline';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { cliLogger as log } from '../utils/logger.js';
import { ProcessManager } from '../discord/process-manager.js';
import { SettingsManager } from '../discord/settings-manager.js';
import {
  OllamaEmbeddingProvider,
  EmbeddingService,
  MemoryService,
  OllamaChatProvider,
  ChatService,
  DistillService,
  MemoryCollector,
} from '../memory/index.js';

const CONFIG_DIR = `${homedir()}/.sleep-code`;
const DISCORD_CONFIG_FILE = `${CONFIG_DIR}/discord.env`;

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function discordSetup(): Promise<void> {
  console.log(`
┌─────────────────────────────────────────────────────────────┐
│                Sleep Code Discord Setup                     │
└─────────────────────────────────────────────────────────────┘

This will guide you through setting up the Discord bot for
monitoring Claude Code sessions.

Step 1: Create a Discord Application
────────────────────────────────────
1. Go to: https://discord.com/developers/applications
2. Click "New Application"
3. Give it a name (e.g., "Sleep Code")
4. Click "Create"

Step 2: Create a Bot
────────────────────
1. Go to "Bot" in the sidebar
2. Click "Add Bot" → "Yes, do it!"
3. Under "Privileged Gateway Intents", enable:
   • MESSAGE CONTENT INTENT
4. Click "Reset Token" and copy the token

Step 3: Invite the Bot
──────────────────────
1. Go to "OAuth2" → "URL Generator"
2. Select scopes: "bot"
3. Select permissions:
   • Send Messages
   • Manage Messages (for pinning)
   • Manage Channels
   • Read Message History
4. Copy the URL and open it to invite the bot to your server
`);

  await prompt('Press Enter when you have created and invited the bot...');

  console.log(`
Now let's collect your credentials:

• Bot Token: "Bot" → "Token" (click "Reset Token" if needed)
• Your User ID: Enable Developer Mode in Discord settings,
  then right-click your name → "Copy User ID"
`);

  const botToken = await prompt('Bot Token: ');
  if (!botToken || botToken.length < 50) {
    console.error('Invalid bot token.');
    process.exit(1);
  }

  const userId = await prompt('Your Discord User ID: ');
  if (!userId || !/^\d+$/.test(userId)) {
    console.error('Invalid user ID. Should be a number.');
    process.exit(1);
  }

  // Save configuration
  await mkdir(CONFIG_DIR, { recursive: true });

  const envContent = `# Sleep Code Discord Configuration
DISCORD_BOT_TOKEN=${botToken}
DISCORD_USER_ID=${userId}
`;

  await writeFile(DISCORD_CONFIG_FILE, envContent);
  console.log(`
✓ Configuration saved to ${DISCORD_CONFIG_FILE}

To start the Discord bot, run:
  sleep-code discord

Then start a Claude Code session with:
  sleep-code run -- claude
`);
}

async function loadEnvFile(path: string): Promise<Record<string, string>> {
  if (!(await fileExists(path))) return {};

  const content = await readFile(path, 'utf-8');
  const config: Record<string, string> = {};

  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...valueParts] = line.split('=');
    config[key.trim()] = valueParts.join('=').trim();
  }
  return config;
}

export async function discordRun(): Promise<void> {
  // Load config from multiple sources (in order of precedence):
  // 1. Environment variables (highest priority)
  // 2. Local .env file
  // 3. ~/.sleep-code/discord.env (lowest priority)

  const globalConfig = await loadEnvFile(DISCORD_CONFIG_FILE);
  const localConfig = await loadEnvFile(`${process.cwd()}/.env`);

  // Merge configs (local overrides global, env vars override both)
  const config: Record<string, string> = {
    ...globalConfig,
    ...localConfig,
  };

  // Environment variables take highest precedence
  if (process.env.DISCORD_BOT_TOKEN) config.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  if (process.env.DISCORD_USER_ID) config.DISCORD_USER_ID = process.env.DISCORD_USER_ID;

  // Validate required config
  const required = ['DISCORD_BOT_TOKEN', 'DISCORD_USER_ID'];
  const missing = required.filter((key) => !config[key]);

  if (missing.length > 0) {
    console.error(`Missing config: ${missing.join(', ')}`);
    console.error('');
    console.error('Provide tokens via:');
    console.error('  - Environment variables (DISCORD_BOT_TOKEN, DISCORD_USER_ID)');
    console.error('  - Local .env file');
    console.error('  - Run "sleep-code discord setup" for guided configuration');
    process.exit(1);
  }

  // Import and run the discord bot
  const { createDiscordApp } = await import('../discord/discord-app.js');

  // Show where config was loaded from
  const localEnvExists = await fileExists(`${process.cwd()}/.env`);
  const globalEnvExists = await fileExists(DISCORD_CONFIG_FILE);
  const source = localEnvExists ? '.env' : globalEnvExists ? DISCORD_CONFIG_FILE : 'environment';
  log.info({ source }, 'Loaded config');
  log.info('Starting Discord bot...');

  // Initialize settings manager first (needed by process manager)
  const settingsManager = new SettingsManager();

  // Initialize process manager with callbacks
  const processManager = new ProcessManager({
    onStatusChange: (entry, oldStatus) => {
      log.info({ sessionId: entry.sessionId, status: entry.status, oldStatus }, 'Session status changed');
      // TODO: Could notify Discord thread here if entry.threadId exists
    },
    getAutoCleanupOrphans: () => settingsManager.shouldAutoCleanupOrphans(),
  });

  try {
    await processManager.initialize();
    await settingsManager.initialize();
    log.info('Managers initialized');
  } catch (err) {
    log.error({ err }, 'Failed to initialize managers');
    process.exit(1);
  }

  const discordConfig = {
    botToken: config.DISCORD_BOT_TOKEN,
    userId: config.DISCORD_USER_ID,
  };

  // Auto-detect Codex availability: OAuth tokens (~/.codex/auth.json) or API key
  const openaiKey = config.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    process.env.OPENAI_API_KEY = openaiKey;
  }

  const codexAuthFile = `${homedir()}/.codex/auth.json`;
  const hasCodexOAuth = await fileExists(codexAuthFile);
  const enableCodex = hasCodexOAuth || !!openaiKey;

  if (enableCodex) {
    const method = hasCodexOAuth ? 'OAuth (~/.codex/auth.json)' : 'API key';
    log.info({ method }, 'Codex integration enabled');
  } else {
    log.info('No Codex auth found (run `codex login` or set OPENAI_API_KEY), Codex disabled');
  }

  // Initialize memory collector (optional — disable with DISABLE_MEMORY=1)
  let memoryCollector: MemoryCollector | undefined;
  let memoryService: MemoryService | undefined;
  if (process.env.DISABLE_MEMORY === '1') {
    log.info('Memory collector disabled via DISABLE_MEMORY=1');
  } else {
    try {
      const embeddingProvider = new OllamaEmbeddingProvider();
      const embeddingService = new EmbeddingService(embeddingProvider);
      await embeddingService.initialize();
      memoryService = new MemoryService(embeddingService);
      await memoryService.initialize();
      const chatProvider = new OllamaChatProvider();
      const chatService = new ChatService(chatProvider);
      await chatService.initialize();
      const distillService = new DistillService(chatService);
      memoryCollector = new MemoryCollector(memoryService, distillService);
      log.info('Memory collector initialized');
    } catch (err) {
      log.warn({ err }, 'Memory collector disabled (Ollama not available?)');
      // Even if Ollama fails, try to initialize memory service for batch distill (uses SDK)
      if (!memoryService) {
        try {
          const embeddingProvider = new OllamaEmbeddingProvider();
          const embeddingService = new EmbeddingService(embeddingProvider);
          await embeddingService.initialize();
          memoryService = new MemoryService(embeddingService);
          await memoryService.initialize();
          // Create collector without legacy distill (batch runner will be attached later)
          const dummyChatProvider = new OllamaChatProvider();
          const dummyChatService = new ChatService(dummyChatProvider);
          const dummyDistill = new DistillService(dummyChatService);
          memoryCollector = new MemoryCollector(memoryService, dummyDistill);
          log.info('Memory collector initialized (batch mode only — Ollama unavailable for legacy distill)');
        } catch (err2) {
          log.warn({ err: err2 }, 'Memory service initialization also failed');
        }
      }
    }
  }

  const { client, sessionManager, channelManager, claudeSdkSessionManager, codexSessionManager, cleanup } = createDiscordApp(discordConfig, {
    processManager,
    settingsManager,
    enableCodex,
    memoryCollector,
    memoryService,
  });

  // Start session manager (Unix socket server for CLI connections)
  try {
    await sessionManager.start();
    log.info('Session manager started');
  } catch (err) {
    log.error({ err }, 'Failed to start session manager');
    process.exit(1);
  }

  // Start Discord bot
  try {
    await client.login(config.DISCORD_BOT_TOKEN);
    log.info('Discord bot is running!');
    console.log('Start a Claude Code session with: sleep-code run -- claude');
    console.log('Or use /claude start in Discord to spawn sessions remotely');
    console.log('Each session will create a #sleep-* channel');

    // Wait for channelManager to be ready before running reconciliation (Issue 3)
    log.info('Waiting for channel manager initialization...');
    const isReady = await channelManager.waitForInit();
    if (isReady) {
      // Grace period: wait for CLIs to reconnect via socket before reconciling
      // CLI reconnect backoff goes up to 30s, so wait long enough for worst case
      log.info('Waiting 35s for CLI sessions to reconnect before reconciliation...');
      await new Promise(r => setTimeout(r, 35000));
      await runStartupReconciliation();
    } else {
      log.warn('Channel manager failed to initialize, skipping reconciliation');
    }
  } catch (err) {
    log.error({ err }, 'Failed to start Discord bot');
    process.exit(1);
  }

  // Startup reconciliation: notify Discord threads about sessions that died during downtime
  async function runStartupReconciliation() {
    // Re-run health check after the grace period to get fresh status
    await processManager.runHealthCheck();

    const deadSessions = processManager.getDeadSessionsNeedingNotification();
    if (deadSessions.length === 0) {
      log.info('Startup reconciliation: no dead sessions to notify');
      return;
    }

    log.info({ count: deadSessions.length }, 'Startup reconciliation: notifying dead sessions');

    const restorableIds: string[] = [];

    for (const entry of deadSessions) {
      if (!entry.threadId) continue;

      // Safety check 1: if the session has already reconnected via socket, skip cleanup
      const liveSession = sessionManager.getSession(entry.sessionId);
      if (liveSession) {
        log.info({ sessionId: entry.sessionId }, 'Session reconnected during grace period, skipping cleanup');
        await processManager.updateStatus(entry.sessionId, 'running');
        continue;
      }

      // Safety check 2: if the process is still alive (PID check), don't kill the mapping
      // The CLI may just be slow to reconnect (backoff delay)
      const freshEntry = await processManager.getEntry(entry.sessionId);
      if (freshEntry && freshEntry.pid > 0) {
        try {
          process.kill(freshEntry.pid, 0);
          // Process is alive — skip cleanup, revive entry
          log.info({ sessionId: entry.sessionId, pid: freshEntry.pid }, 'Process still alive, skipping cleanup');
          await processManager.updateStatus(entry.sessionId, 'running');
          continue;
        } catch {
          // Process is dead, proceed with restore offer
        }
      }

      try {
        const channel = await client.channels.fetch(entry.threadId);
        if (channel?.isThread()) {
          // Unarchive if needed to send message
          if (channel.archived) {
            await channel.setArchived(false);
          }

          // Post restore/dismiss buttons instead of cleaning up
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`restore:${entry.sessionId}`)
              .setLabel('Restore Session')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`dismiss_restore:${entry.sessionId}`)
              .setLabel('Dismiss')
              .setStyle(ButtonStyle.Secondary),
          );

          await channel.send({
            content:
              `💀 **Session Lost During Bot Downtime**\n` +
              `Session: \`${entry.sessionId.slice(0, 8)}...\`\n` +
              `Directory: \`${entry.cwd}\`\n\n` +
              `Click **Restore** to resume with conversation history, or **Dismiss** to clean up.\n` +
              `_Auto-dismissed in 1 hour._`,
            components: [row],
          });

          // Mark as needs_restore (keep persisted mapping for thread reuse)
          await processManager.updateStatus(entry.sessionId, 'needs_restore');
          restorableIds.push(entry.sessionId);

          log.info({ sessionId: entry.sessionId, threadId: entry.threadId }, 'Posted restore offer');
        }
      } catch (err) {
        log.error({ err, sessionId: entry.sessionId, threadId: entry.threadId }, 'Failed to post restore offer');
        // Fall back to cleanup
        await processManager.removeEntry(entry.sessionId);
        await channelManager.removePersistedMapping(entry.sessionId);
      }
    }

    // Auto-dismiss unclaimed restore offers after 1 hour
    if (restorableIds.length > 0) {
      setTimeout(async () => {
        for (const sessionId of restorableIds) {
          const entry = await processManager.getEntry(sessionId);
          if (entry?.status !== 'needs_restore') continue;

          await processManager.removeEntry(sessionId);
          await channelManager.removePersistedMapping(sessionId);

          if (entry.threadId) {
            try {
              const ch = await client.channels.fetch(entry.threadId);
              if (ch?.isThread()) {
                await ch.send('⏰ **Restore expired** — session cleaned up.');
                await ch.setArchived(true);
              }
            } catch {
              // Thread may be gone
            }
          }
          log.info({ sessionId }, 'Auto-dismissed expired restore offer');
        }
      }, 60 * 60 * 1000);
    }

    log.info({ restored: restorableIds.length }, 'Startup reconciliation complete');

    // SDK session reconciliation: lazy resume handles everything now.
    // Just log and keep persisted mappings alive — sessions will auto-resume
    // when the user sends a message in the thread.
    const sdkPersisted = channelManager.getPersistedSdkMappings();
    if (sdkPersisted.length > 0) {
      log.info({ count: sdkPersisted.length }, 'SDK reconciliation: persisted SDK mappings kept for lazy resume');
    }
  }

  // Graceful shutdown — interrupt running sessions before exit
  const shutdown = async () => {
    log.info('Shutting down...');

    // 1. Graceful shutdown SDK sessions (preserves persisted mappings for lazy resume)
    if (claudeSdkSessionManager) {
      const count = claudeSdkSessionManager.getAllSessions().length;
      if (count > 0) {
        log.info({ count }, 'Shutting down SDK sessions (preserving mappings for lazy resume)...');
        await claudeSdkSessionManager.shutdown();
      }
    }

    // 2. Interrupt all running Codex sessions
    let interrupted = 0;
    if (codexSessionManager) {
      for (const session of codexSessionManager.getAllSessions()) {
        if (session.status === 'running') {
          codexSessionManager.interruptSession(session.id);
          interrupted++;
        }
      }
    }

    if (interrupted > 0) {
      log.info({ interrupted }, 'Interrupted Codex sessions, waiting for streams to settle...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 3. Clean up everything else
    await cleanup();
    processManager.shutdown();
    sessionManager.stop();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
