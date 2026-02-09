import { run } from './run.js';
import { slackSetup, slackRun } from './slack.js';
import { discordSetup, discordRun } from './discord.js';
import { telegramSetup, telegramRun } from './telegram.js';
import { handlePermissionHook } from './hook.js';
import { readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { resolve } from 'path';

async function setupHook(): Promise<void> {
  const settingsPath = resolve(homedir(), '.claude', 'settings.json');

  let settings: any = {};
  try {
    const content = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(content);
  } catch {
    // File doesn't exist or is invalid
  }

  // Add hooks configuration
  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Get the path to the sleep-code binary
  const sleepCodePath = process.argv[1]; // Current script path
  const hookCommand = `node ${sleepCodePath} hook`;

  settings.hooks.PermissionRequest = [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: hookCommand,
          timeout: 86400,
        },
      ],
    },
  ];

  await writeFile(settingsPath, JSON.stringify(settings, null, 2));
  console.log('✅ Hook configured in ~/.claude/settings.json');
  console.log(`   Command: ${hookCommand}`);
  console.log('\n⚠️  Make sure the Discord bot is running to receive permission requests.');
}

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case 'run': {
      // Find -- separator and get command after it
      const separatorIndex = args.indexOf('--');
      if (separatorIndex === -1) {
        console.error('Usage: sleep-code run [--session-id <uuid>] -- <command> [args...]');
        console.error('Example: sleep-code run -- claude');
        process.exit(1);
      }

      // Parse options before --
      const runOptions = args.slice(1, separatorIndex);
      let providedSessionId: string | undefined;

      const sessionIdIndex = runOptions.indexOf('--session-id');
      if (sessionIdIndex !== -1 && runOptions[sessionIdIndex + 1]) {
        providedSessionId = runOptions[sessionIdIndex + 1];
      }

      const cmd = args.slice(separatorIndex + 1);
      if (cmd.length === 0) {
        console.error('No command specified after --');
        process.exit(1);
      }
      await run(cmd, providedSessionId);
      break;
    }

    case 'slack': {
      if (args[1] === 'setup') {
        await slackSetup();
      } else {
        await slackRun();
      }
      break;
    }

    case 'discord': {
      if (args[1] === 'setup') {
        await discordSetup();
      } else {
        await discordRun();
      }
      break;
    }

    case 'telegram': {
      if (args[1] === 'setup') {
        await telegramSetup();
      } else {
        await telegramRun();
      }
      break;
    }

    case 'hook': {
      if (args[1] === 'setup') {
        await setupHook();
      } else {
        // Hook handler for Claude Code PermissionRequest
        await handlePermissionHook();
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined: {
      console.log(`
Sleep Code - Monitor Claude Code sessions from Slack/Discord/Telegram

Commands:
  telegram           Run the Telegram bot
  telegram setup     Configure Telegram integration
  discord            Run the Discord bot
  discord setup      Configure Discord integration
  slack              Run the Slack bot
  slack setup        Configure Slack integration
  hook setup         Configure Claude Code permission hook
  run -- <cmd>       Start a monitored session
  run --session-id <uuid> -- <cmd>  Start with specific session ID
  help               Show this help message

Examples:
  sleep-code telegram setup   # First-time Telegram configuration
  sleep-code telegram         # Start the Telegram bot
  sleep-code discord setup    # First-time Discord configuration
  sleep-code discord          # Start the Discord bot
  sleep-code slack setup      # First-time Slack configuration
  sleep-code slack            # Start the Slack bot
  sleep-code hook setup       # Configure permission forwarding
  sleep-code run -- claude    # Start a Claude Code session

Discord Commands (after /claude add-dir):
  /claude start      Start session in a whitelisted directory
  /claude stop       Stop a running session
  /claude status     Show all managed sessions
  /claude add-dir    Add directory to whitelist
  /claude remove-dir Remove directory from whitelist
  /claude list-dirs  List whitelisted directories
`);
      break;
    }

    default: {
      // Treat unknown commands as a program to run
      await run(args);
      break;
    }
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
