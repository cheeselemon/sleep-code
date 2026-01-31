import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Log directory: ~/.sleep-code/logs
const LOG_DIR = join(homedir(), '.sleep-code', 'logs');

// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

// Create rotating file stream
// - Daily rotation
// - 7 days retention
// - Compressed old logs
const fileStream = createStream('sleep-code.log', {
  path: LOG_DIR,
  size: '10M', // Also rotate if file exceeds 10MB
  interval: '1d', // Daily rotation
  maxFiles: 7, // Keep 7 days of logs
  compress: 'gzip', // Compress old logs
});

// Create pino logger with multiple destinations
const streams = [
  // Console output (pretty for development)
  { stream: process.stdout },
  // File output (JSON for parsing)
  { stream: fileStream },
];

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream(streams)
);

// Child loggers for different components
export const cliLogger = logger.child({ component: 'cli' });
export const discordLogger = logger.child({ component: 'discord' });
export const slackLogger = logger.child({ component: 'slack' });
export const telegramLogger = logger.child({ component: 'telegram' });
export const sessionLogger = logger.child({ component: 'session' });
export const hookLogger = logger.child({ component: 'hook' });

export default logger;
