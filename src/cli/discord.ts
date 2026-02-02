import { homedir } from 'os';
import { mkdir, writeFile, readFile, access } from 'fs/promises';
import * as readline from 'readline';
import { cliLogger as log } from '../utils/logger.js';
import { ProcessManager } from '../discord/process-manager.js';
import { SettingsManager } from '../discord/settings-manager.js';

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

  const { client, sessionManager, channelManager, cleanup } = createDiscordApp(discordConfig, {
    processManager,
    settingsManager,
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
    const deadSessions = processManager.getDeadSessionsNeedingNotification();
    if (deadSessions.length === 0) {
      log.info('Startup reconciliation: no dead sessions to notify');
      return;
    }

    log.info({ count: deadSessions.length }, 'Startup reconciliation: notifying dead sessions');

    // Mark all sessions being reconciled to prevent race condition with onSessionConnected
    for (const entry of deadSessions) {
      processManager.markAsReconciling(entry.sessionId);
    }

    try {
      for (const entry of deadSessions) {
        if (!entry.threadId) continue;

        try {
          const channel = await client.channels.fetch(entry.threadId);
          if (channel?.isThread()) {
            // Unarchive if needed to send message
            if (channel.archived) {
              await channel.setArchived(false);
            }

            // Send notification
            const statusEmoji = entry.status === 'orphaned' ? '💀' : '🛑';
            const reason = entry.status === 'orphaned'
              ? 'Session crashed or became unresponsive'
              : 'Session ended';
            await channel.send(
              `${statusEmoji} **Session Lost During Bot Downtime**\n` +
              `Reason: ${reason}\n` +
              `Session: \`${entry.sessionId.slice(0, 8)}...\`\n` +
              `Directory: \`${entry.cwd}\``
            );

            // Archive the thread
            await channel.setArchived(true);
            log.info({ sessionId: entry.sessionId, threadId: entry.threadId }, 'Notified dead session thread');
          }
        } catch (err) {
          log.error({ err, sessionId: entry.sessionId, threadId: entry.threadId }, 'Failed to notify dead session');
        }

        // Clean up the entry from registry
        await processManager.removeEntry(entry.sessionId);

        // Clean up channel manager mapping (Issue 2: add await)
        await channelManager.removePersistedMapping(entry.sessionId);
      }
    } finally {
      // Unmark all sessions from reconciliation
      for (const entry of deadSessions) {
        processManager.unmarkAsReconciling(entry.sessionId);
      }
    }

    log.info('Startup reconciliation complete');
  }

  // Graceful shutdown
  const shutdown = () => {
    log.info('Shutting down...');
    cleanup(); // Clean up intervals (Issue 6)
    processManager.shutdown();
    sessionManager.stop();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
