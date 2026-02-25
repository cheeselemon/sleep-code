/**
 * Utility functions for Discord app
 */

import type { Attachment, Client, ThreadChannel } from 'discord.js';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { discordLogger as log } from '../utils/logger.js';
import { IMAGE_EXTENSIONS, TEXT_EXTENSIONS, MAX_TEXT_FILE_SIZE } from './state.js';
import type { ChannelManager } from './channel-manager.js';

/**
 * Download Discord attachment to temp directory
 */
export async function downloadAttachment(attachment: Attachment): Promise<string | null> {
  const ext = attachment.name?.toLowerCase().split('.').pop() || '';
  if (!IMAGE_EXTENSIONS.includes(`.${ext}`)) {
    return null; // Not an image
  }

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      log.error({ status: response.status }, 'Failed to download attachment');
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const tempDir = join(tmpdir(), 'sleep-code-images');
    await mkdir(tempDir, { recursive: true });

    const filename = `${Date.now()}-${attachment.name || 'image.png'}`;
    const filepath = join(tempDir, filename);
    await writeFile(filepath, buffer);

    log.info({ filepath }, 'Downloaded image');
    return filepath;
  } catch (err) {
    log.error({ err }, 'Error downloading attachment');
    return null;
  }
}

export interface TextAttachmentResult {
  success: boolean;
  content?: string;
  filename?: string;
  error?: 'size_exceeded' | 'download_failed';
  size?: number;
}

/**
 * Download text attachment and return its content
 */
export async function downloadTextAttachment(attachment: Attachment): Promise<TextAttachmentResult | null> {
  const ext = attachment.name?.toLowerCase().split('.').pop() || '';
  if (!TEXT_EXTENSIONS.includes(`.${ext}`)) {
    return null; // Not a text file
  }

  // Check size before downloading
  if (attachment.size > MAX_TEXT_FILE_SIZE) {
    log.warn({ filename: attachment.name, size: attachment.size, max: MAX_TEXT_FILE_SIZE }, 'Text file too large');
    return {
      success: false,
      filename: attachment.name || 'unknown.txt',
      error: 'size_exceeded',
      size: attachment.size,
    };
  }

  try {
    const response = await fetch(attachment.url);
    if (!response.ok) {
      log.error({ status: response.status }, 'Failed to download text attachment');
      return {
        success: false,
        filename: attachment.name || 'unknown.txt',
        error: 'download_failed',
      };
    }

    const content = await response.text();
    log.info({ filename: attachment.name, length: content.length }, 'Downloaded text file');
    return {
      success: true,
      content,
      filename: attachment.name || 'unknown.txt',
    };
  } catch (err) {
    log.error({ err }, 'Error downloading text attachment');
    return {
      success: false,
      filename: attachment.name || 'unknown.txt',
      error: 'download_failed',
    };
  }
}

/**
 * Check which terminal apps are installed (macOS)
 */
export function getInstalledTerminals(): { terminal: boolean; iterm2: boolean } {
  return {
    terminal: existsSync('/System/Applications/Utilities/Terminal.app') ||
              existsSync('/Applications/Utilities/Terminal.app'),
    iterm2: existsSync('/Applications/iTerm.app'),
  };
}

/**
 * Parse agent prefix from message content for routing
 */
export type AgentType = 'claude' | 'codex';

export interface RoutingDirective {
  target: AgentType;
  cleanContent: string;
  explicit: boolean;         // true = first token is @codex/@claude or legacy prefix
  invalidMention: boolean;   // true = @codex/@claude found mid-body (not in code blocks)
  bodyMentionTarget?: AgentType; // which agent was @mentioned mid-body (for fallback routing)
}

/**
 * Strip code blocks (``` and inline `) from text for mention scanning.
 */
function stripCodeBlocks(text: string): string {
  // Remove fenced code blocks first, then inline code
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

/**
 * Strip BOM and zero-width characters that LLMs sometimes emit.
 */
function normalizeInvisible(text: string): string {
  return text.replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '');
}

/**
 * Extract which agent is @mentioned in body text (outside code blocks).
 * Returns the first match found, or undefined.
 */
function extractBodyMentionTarget(text: string): AgentType | undefined {
  const stripped = normalizeInvisible(stripCodeBlocks(text));
  const match = stripped.match(/@(codex|claude)\b/i);
  return match ? (match[1].toLowerCase() as AgentType) : undefined;
}

export function parseRoutingDirective(
  content: string,
  context: { hasClaude: boolean; hasCodex: boolean; lastActive?: AgentType }
): RoutingDirective {
  const trimmed = normalizeInvisible(content).trimStart();

  // Check @mention style: @codex or @claude (with optional colon/space after)
  // Use lookahead to prevent matching @codex-foo or @claude-bar
  const codexMention = /^@codex(?=[:\s]|$)[:\s]*/i;
  const claudeMention = /^@claude(?=[:\s]|$)[:\s]*/i;

  if (codexMention.test(trimmed)) {
    const cleanContent = trimmed.replace(codexMention, '').trimStart();
    return { target: 'codex', cleanContent, explicit: true, invalidMention: false };
  }
  if (claudeMention.test(trimmed)) {
    const cleanContent = trimmed.replace(claudeMention, '').trimStart();
    return { target: 'claude', cleanContent, explicit: true, invalidMention: false };
  }

  // Legacy prefix support: x:/c:/codex:/claude:
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('x:') || lower.startsWith('codex:')) {
    const colonIdx = content.indexOf(':');
    return { target: 'codex', cleanContent: content.slice(colonIdx + 1).trimStart(), explicit: true, invalidMention: false };
  }
  if (lower.startsWith('c:') || lower.startsWith('claude:')) {
    const colonIdx = content.indexOf(':');
    return { target: 'claude', cleanContent: content.slice(colonIdx + 1).trimStart(), explicit: true, invalidMention: false };
  }

  // No explicit prefix — detect mid-body mentions (outside code blocks)
  const bodyMentionTarget = extractBodyMentionTarget(content);
  const invalidMention = bodyMentionTarget !== undefined;

  // Default routing: single agent → that agent, both → lastActive ?? claude
  let target: AgentType;
  if (context.hasClaude && !context.hasCodex) target = 'claude';
  else if (context.hasCodex && !context.hasClaude) target = 'codex';
  else target = context.lastActive || 'claude';

  return { target, cleanContent: content, explicit: false, invalidMention, bodyMentionTarget };
}

/** @deprecated Use parseRoutingDirective instead */
export function parseAgentPrefix(
  content: string,
  context: { hasClaude: boolean; hasCodex: boolean; lastActive?: AgentType }
): { target: AgentType; cleanContent: string } {
  const { target, cleanContent } = parseRoutingDirective(content, context);
  return { target, cleanContent };
}

/**
 * Helper to get thread for sending messages
 */
export async function getThread(
  client: Client,
  channelManager: ChannelManager,
  sessionId: string
): Promise<ThreadChannel | null> {
  const session = channelManager.getSession(sessionId);
  if (!session) {
    log.debug({ sessionId }, 'getThread: No session mapping');
    return null;
  }
  try {
    const thread = await client.channels.fetch(session.threadId);
    if (thread?.isThread()) return thread;
    log.debug({ threadId: session.threadId }, 'getThread: Channel is not a thread');
  } catch (err) {
    log.debug({ threadId: session.threadId, err }, 'getThread: Failed to fetch thread');
  }
  return null;
}
