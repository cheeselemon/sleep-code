/**
 * Utility functions for Discord app
 */

import type { Attachment, Client, ThreadChannel } from 'discord.js';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, resolve, sep } from 'path';
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
import { getAllAliases } from './agents/model-registry.js';

export type AgentType = string;

export interface RoutingDirective {
  target: AgentType;
  cleanContent: string;
  explicit: boolean;         // true = first token is @codex/@claude or legacy prefix
  invalidMention: boolean;   // true = @codex/@claude found mid-body (not in code blocks)
  bodyMentionTarget?: AgentType; // which agent was @mentioned mid-body (for fallback routing)
}

/**
 * Build dynamic regex for all known agent names (claude, codex, + model aliases)
 */
function buildAgentNames(): string[] {
  return ['claude', 'codex', ...getAllAliases()];
}

function buildAgentRegex(): RegExp {
  const allNames = buildAgentNames();
  const pattern = allNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}._%+-])@(${pattern})(?![\\p{L}\\p{N}_-])`, 'giu');
}

function buildAgentPrefixRegex(): Array<{ name: string; regex: RegExp }> {
  return buildAgentNames().map(name => ({
    name,
    regex: new RegExp(`^@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[:\\s]|$)[:\\s]*`, 'i'),
  }));
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
 * When exclude is provided, skip mentions of that agent (e.g. exclude the source agent).
 * Returns the first non-excluded match found, or undefined.
 */
function extractBodyMentionTarget(text: string, exclude?: AgentType): AgentType | undefined {
  const stripped = normalizeInvisible(stripCodeBlocks(text));
  // Dynamic regex: matches @claude, @codex, @gemma4, @glm5, @qwen3-coder, etc.
  const regex = buildAgentRegex();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stripped)) !== null) {
    const agent = match[1].toLowerCase() as AgentType;
    if (agent !== exclude) return agent;
  }
  return undefined;
}

export function parseRoutingDirective(
  content: string,
  context: { hasClaude: boolean; hasCodex: boolean; hasAgents?: Map<string, boolean>; lastActive?: AgentType }
): RoutingDirective {
  const trimmed = normalizeInvisible(content).trimStart();

  // Check @mention style: @codex, @claude, @gemma4, @glm5, @qwen3-coder, etc.
  // Dynamic regex built from model registry
  for (const { name, regex } of buildAgentPrefixRegex()) {
    if (regex.test(trimmed)) {
      const cleanContent = trimmed.replace(regex, '').trimStart();
      return { target: name, cleanContent, explicit: true, invalidMention: false };
    }
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
  // Exclude the source agent (lastActive) so self-mentions don't block routing to the other agent
  const bodyMentionTarget = extractBodyMentionTarget(content, context.lastActive);
  const invalidMention = bodyMentionTarget !== undefined;

  // Default routing (no explicit @mention):
  //   single agent thread → that agent
  //   multi-agent thread → always Claude (Claude is the primary agent)
  //   generic-agent-only thread → that agent (no claude/codex present)
  let target: AgentType;
  if (context.hasClaude) target = 'claude';
  else if (context.hasCodex && !(context.hasAgents?.size)) target = 'codex';
  else if (!context.hasClaude && !context.hasCodex && context.hasAgents?.size === 1) {
    // Only one generic agent, no claude/codex — route to it
    target = context.hasAgents.keys().next().value!;
  } else target = 'claude';

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

export const DISCORD_ATTACHMENT_SIZE_LIMIT = 25 * 1024 * 1024; // 25MB

export interface AttachmentPathValidationResult {
  ok: boolean;
  normalizedPath?: string;
  realPath?: string;
  size?: number;
  error?: 'not_absolute' | 'outside_cwd' | 'missing' | 'stat_failed';
}

function isWithinRoot(candidatePath: string, rootPath: string): boolean {
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

export function validateAttachmentPath(
  filePath: string,
  cwd: string,
  options?: { requireExists?: boolean },
): AttachmentPathValidationResult {
  if (!isAbsolute(filePath)) {
    return { ok: false, error: 'not_absolute' };
  }

  const normalizedPath = resolve(filePath);
  const normalizedCwd = resolve(cwd);
  if (!isWithinRoot(normalizedPath, normalizedCwd)) {
    return { ok: false, error: 'outside_cwd' };
  }

  const requireExists = options?.requireExists ?? true;
  if (!requireExists && !existsSync(normalizedPath)) {
    return { ok: true, normalizedPath };
  }

  try {
    const realCwd = realpathSync(normalizedCwd);
    const realPath = realpathSync(normalizedPath);
    if (!isWithinRoot(realPath, realCwd)) {
      return { ok: false, error: 'outside_cwd' };
    }

    const size = statSync(realPath).size;
    return { ok: true, normalizedPath, realPath, size };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { ok: false, error: 'missing', normalizedPath };
    }
    log.warn({ err, filePath, cwd }, 'Failed to validate attachment path');
    return { ok: false, error: 'stat_failed', normalizedPath };
  }
}

export function formatAttachmentSizeMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
