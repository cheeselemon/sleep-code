import type { TodoItem } from '../types.js';

/**
 * Format Claude Code command messages (slash commands like /context, /compact, etc.)
 * Raw format: <command-name>/cmd</command-name><command-message>msg</command-message><command-args>args</command-args>
 * Formatted: > 🔧 `/cmd` args
 */
export function formatCommandMessage(content: string): string | null {
  const nameMatch = content.match(/<command-name>(.*?)<\/command-name>/s);
  if (!nameMatch) return null;

  const commandName = nameMatch[1].trim();
  const messageMatch = content.match(/<command-message>(.*?)<\/command-message>/s);
  const argsMatch = content.match(/<command-args>(.*?)<\/command-args>/s);

  const args = argsMatch?.[1]?.trim();
  const message = messageMatch?.[1]?.trim();

  // Build display: show command name, then args or message if they add info
  let display = `\`${commandName}\``;
  if (args) {
    display += ` ${args}`;
  } else if (message && message !== commandName.replace(/^\//, '')) {
    display += ` ${message}`;
  }

  return display;
}

/**
 * Convert GitHub-flavored markdown to Slack mrkdwn format
 */
export function markdownToSlack(markdown: string): string {
  let text = markdown;

  // Bold: **text** -> *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // Headers: # Header -> *Header*
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Links: [text](url) -> <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Strikethrough: ~~text~~ -> ~text~
  text = text.replace(/~~(.+?)~~/g, '~$1~');

  return text;
}

/**
 * Split long messages to fit within Slack's 40k char limit
 */
export function chunkMessage(text: string, maxLength = 39000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point (newline or space)
    let breakPoint = remaining.lastIndexOf('\n', maxLength);
    if (breakPoint === -1 || breakPoint < maxLength / 2) {
      breakPoint = remaining.lastIndexOf(' ', maxLength);
    }
    if (breakPoint === -1 || breakPoint < maxLength / 2) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.slice(0, breakPoint));
    remaining = remaining.slice(breakPoint).trimStart();
  }

  return chunks;
}

/**
 * Format session status with emoji
 */
export function formatSessionStatus(status: 'running' | 'idle' | 'ended'): string {
  const icons: Record<string, string> = {
    running: ':hourglass_flowing_sand:',
    idle: ':white_check_mark:',
    ended: ':stop_sign:',
  };
  const labels: Record<string, string> = {
    running: 'Running',
    idle: 'Idle',
    ended: 'Ended',
  };
  return `${icons[status]} ${labels[status]}`;
}

/**
 * Format todo list with status icons
 */
export function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '';

  const icons: Record<string, string> = {
    pending: ':white_circle:',
    in_progress: ':large_blue_circle:',
    completed: ':white_check_mark:',
  };

  return todos
    .map((t) => {
      const icon = icons[t.status] || ':white_circle:';
      const text = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
      return `${icon} ${text}`;
    })
    .join('\n');
}
