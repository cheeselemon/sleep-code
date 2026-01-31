import { createSlackApp } from './slack-app.js';
import type { SlackConfig } from './types.js';
import { slackLogger as log } from '../utils/logger.js';

async function main() {
  const config: SlackConfig = {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    appToken: process.env.SLACK_APP_TOKEN || '',
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
    userId: process.env.SLACK_USER_ID || '',
  };

  // Validate required config
  const required: (keyof SlackConfig)[] = ['botToken', 'appToken', 'userId'];

  const missing = required.filter((key) => !config[key]);
  if (missing.length > 0) {
    log.error({ missing }, 'Missing required config');
    console.error('Required environment variables:');
    console.error('  SLACK_BOT_TOKEN     - Bot User OAuth Token (xoxb-...)');
    console.error('  SLACK_APP_TOKEN     - App-Level Token for Socket Mode (xapp-...)');
    console.error('  SLACK_USER_ID       - Your Slack user ID (U...)');
    console.error('Optional:');
    console.error('  SLACK_SIGNING_SECRET - Signing secret (for request verification)');
    process.exit(1);
  }

  log.info('Starting Sleep Code bot...');

  const { app, sessionManager } = createSlackApp(config);

  // Start session manager (Unix socket server for CLI connections)
  try {
    await sessionManager.start();
    log.info('Session manager started');
  } catch (err) {
    log.error({ err }, 'Failed to start session manager');
    process.exit(1);
  }

  // Start Slack app
  try {
    await app.start();
    log.info('Bot is running!');
    console.log('Start a Claude Code session with: sleep-code run -- claude');
    console.log('Each session will create a private #sleep-* channel');
  } catch (err) {
    log.error({ err }, 'Failed to start app');
    process.exit(1);
  }
}

main().catch((err) => {
  log.fatal({ err }, 'Fatal error');
  process.exit(1);
});
