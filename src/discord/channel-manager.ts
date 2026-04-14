import type { Client, TextChannel, CategoryChannel, Guild, ThreadChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { discordLogger as log } from '../utils/logger.js';
import { SessionStore } from './session-store.js';
import type { PersistedMapping, ChannelMapping } from './session-store.js';

// Re-export types so existing imports from channel-manager keep working
export type { PersistedMapping, ChannelMapping } from './session-store.js';

const MAPPINGS_DIR = join(homedir(), '.sleep-code');
const MAPPINGS_FILE = join(MAPPINGS_DIR, 'session-mappings.json');
const CODEX_MAPPINGS_FILE = join(MAPPINGS_DIR, 'codex-session-mappings.json');
const SDK_MAPPINGS_FILE = join(MAPPINGS_DIR, 'sdk-session-mappings.json');
const AGENT_MAPPINGS_FILE = join(MAPPINGS_DIR, 'agent-session-mappings.json');

/**
 * Sanitize a string for use as a Discord channel name.
 * Rules: lowercase, no spaces, max 100 chars, only letters/numbers/hyphens/underscores
 */
function sanitizeChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_\s]/g, '') // Remove invalid chars
    .replace(/\s+/g, '-') // Spaces to hyphens
    .replace(/-+/g, '-') // Collapse multiple hyphens
    .replace(/^-|-$/g, '') // Trim hyphens from ends
    .slice(0, 90); // Leave room for "sleep-" prefix and uniqueness suffix
}

// Topic format: "Claude Code | cwd:/path/to/project"
const TOPIC_PREFIX = 'Claude Code |';

function parseTopic(topic: string | null): { cwd?: string } | null {
  if (!topic || !topic.startsWith(TOPIC_PREFIX)) return null;
  const result: { cwd?: string } = {};
  const parts = topic.slice(TOPIC_PREFIX.length).split('|').map(p => p.trim());
  for (const part of parts) {
    if (part.startsWith('cwd:')) {
      result.cwd = part.slice(4);
    }
  }
  return result;
}

function buildTopic(cwd: string): string {
  return `${TOPIC_PREFIX} cwd:${cwd}`;
}

export class ChannelManager {
  // Four session stores — one per session type
  private ptyStore = new SessionStore(MAPPINGS_FILE, 'session');
  private codexStore = new SessionStore(CODEX_MAPPINGS_FILE, 'Codex');
  private sdkStore = new SessionStore(SDK_MAPPINGS_FILE, 'SDK');
  private agentStore = new SessionStore(AGENT_MAPPINGS_FILE, 'Agent');

  // Shared: cwd → channelId (one channel per project, shared across session types)
  private cwdToChannel = new Map<string, string>();

  private client: Client;
  private userId: string;
  private guild: Guild | null = null;
  private category: CategoryChannel | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(client: Client, userId: string) {
    this.client = client;
    this.userId = userId;
  }

  // ── Initialization ────────────────────────────────────

  /**
   * Wait for initialization to complete (with timeout)
   */
  async waitForInit(timeoutMs = 30000): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initPromise) {
      await this.initPromise;
      return this.initialized;
    }

    const startTime = Date.now();
    while (!this.initialized && Date.now() - startTime < timeoutMs) {
      if (this.initPromise) {
        await this.initPromise;
        return this.initialized;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return this.initialized;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.doInitialize();
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // Load persisted session mappings
    await this.ptyStore.load();
    await this.codexStore.load();
    await this.loadSdkMappings(); // SDK has custom dedup/cleanup logic
    await this.agentStore.load();

    // Find the first guild the bot is in
    const guilds = await this.client.guilds.fetch();
    if (guilds.size === 0) {
      throw new Error('Bot is not in any servers. Please invite the bot first.');
    }

    const guildId = guilds.first()!.id;
    this.guild = await this.client.guilds.fetch(guildId);

    // Find or create Sleep Code category
    const existingCategory = this.guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === 'sleep code sessions'
    ) as CategoryChannel | undefined;

    if (existingCategory) {
      this.category = existingCategory;
    } else {
      this.category = await this.guild.channels.create({
        name: 'Sleep Code Sessions',
        type: ChannelType.GuildCategory,
      });
    }

    log.info(`[ChannelManager] Using guild: ${this.guild.name}`);
    log.info(`[ChannelManager] Using category: ${this.category.name}`);

    // Scan existing channels for recovery after restart
    await this.recoverChannels();

    this.initialized = true;
    log.info(`[ChannelManager] Initialization complete`);
  }

  /**
   * Scan existing channels in the category and recover cwd->channel mappings
   */
  private async recoverChannels(): Promise<void> {
    if (!this.guild || !this.category) return;

    const channels = this.guild.channels.cache.filter(
      (ch) => ch.parentId === this.category!.id && ch.type === ChannelType.GuildText
    );

    let recovered = 0;
    for (const [channelId, channel] of channels) {
      if (channel.type !== ChannelType.GuildText) continue;

      const textChannel = channel as TextChannel;
      const topic = textChannel.topic;
      const parsed = parseTopic(topic);
      if (parsed?.cwd) {
        this.cwdToChannel.set(parsed.cwd, channelId);
        recovered++;
        log.info(`[ChannelManager] Recovered channel #${channel.name} for cwd: ${parsed.cwd}`);
      }
    }

    if (recovered > 0) {
      log.info(`[ChannelManager] Recovered ${recovered} channel mappings`);
    }
  }

  // ── Shared channel helpers ────────────────────────────

  /**
   * Get or create a channel for a CWD
   */
  private async getOrCreateChannel(cwd: string): Promise<TextChannel | null> {
    if (!this.guild || !this.category) return null;

    // Check if channel exists for this CWD
    const existingChannelId = this.cwdToChannel.get(cwd);
    if (existingChannelId) {
      try {
        const channel = await this.guild.channels.fetch(existingChannelId);
        if (channel && channel.type === ChannelType.GuildText) {
          return channel as TextChannel;
        }
      } catch {
        // Channel deleted, remove from map
        this.cwdToChannel.delete(cwd);
      }
    }

    // Create new channel
    const folderName = cwd.split('/').filter(Boolean).pop() || 'session';
    const baseName = `sleep-${sanitizeChannelName(folderName)}`;

    let channelName = baseName;
    let suffix = 1;

    while (true) {
      const nameToTry = channelName.slice(0, 100);

      const existing = this.guild.channels.cache.find(
        (ch) => ch.name === nameToTry && ch.parentId === this.category!.id
      );

      if (!existing) {
        try {
          const channel = await this.guild.channels.create({
            name: nameToTry,
            type: ChannelType.GuildText,
            parent: this.category,
            topic: buildTopic(cwd),
          });

          this.cwdToChannel.set(cwd, channel.id);
          log.info(`[ChannelManager] Created channel #${nameToTry} for cwd: ${cwd}`);
          return channel;
        } catch (err: any) {
          log.error('[ChannelManager] Failed to create channel:', err.message);
          return null;
        }
      } else {
        // Check if this existing channel is for the same CWD
        if (existing.type === ChannelType.GuildText) {
          const textChannel = existing as TextChannel;
          const topic = textChannel.topic;
          const parsed = parseTopic(topic);
          if (parsed?.cwd === cwd) {
            this.cwdToChannel.set(cwd, existing.id);
            return textChannel;
          }
        }
        suffix++;
        channelName = `${baseName}-${suffix}`;
      }
    }
  }

  /**
   * Find existing thread for a session ID in a channel
   */
  private async findExistingThread(channel: TextChannel, sessionId: string): Promise<ThreadChannel | null> {
    try {
      const activeThreads = await channel.threads.fetchActive();
      const archivedThreads = await channel.threads.fetchArchived({ type: 'public' });

      for (const [, thread] of activeThreads.threads) {
        if (thread.name.startsWith(sessionId)) {
          log.info(`[ChannelManager] Found existing active thread for session ${sessionId}`);
          return thread;
        }
      }

      for (const [, thread] of archivedThreads.threads) {
        if (thread.name.startsWith(sessionId)) {
          log.info(`[ChannelManager] Found existing archived thread for session ${sessionId}, unarchiving...`);
          await thread.setArchived(false);
          return thread;
        }
      }
    } catch (err) {
      log.error('[ChannelManager] Error searching for existing thread:', err);
    }
    return null;
  }

  // ── PTY Claude session methods ────────────────────────

  /**
   * Create a PTY session (channel + thread)
   */
  async createSession(
    sessionId: string,
    sessionName: string,
    cwd: string
  ): Promise<ChannelMapping | null> {
    if (!this.initialized) {
      log.info(`[ChannelManager] Waiting for initialization before creating session ${sessionId}`);
      const ready = await this.waitForInit();
      if (!ready) {
        log.error('[ChannelManager] Initialization failed, cannot create session');
        return null;
      }
    }

    if (this.ptyStore.has(sessionId)) {
      return this.ptyStore.get(sessionId)!;
    }

    const channel = await this.getOrCreateChannel(cwd);
    if (!channel) return null;

    // Try to find existing thread from persisted mapping
    let thread: ThreadChannel | null = null;
    let isNewThread = false;
    const persisted = this.ptyStore.getPersisted(sessionId);

    if (persisted) {
      try {
        const existingThread = await this.client.channels.fetch(persisted.threadId);
        if (existingThread?.isThread()) {
          thread = existingThread;
          if (thread.archived) {
            await thread.setArchived(false);
          }
          log.info(`[ChannelManager] Found existing thread ${persisted.threadId} for session ${sessionId}`);
        }
      } catch (err) {
        log.info(`[ChannelManager] Persisted thread ${persisted.threadId} not found, will create new`);
        await this.removePersistedMapping(sessionId);
      }
    }

    if (!thread) {
      const timestamp = new Date().toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const threadName = `${sessionId} - ${timestamp}`;

      try {
        thread = await channel.threads.create({
          name: threadName.slice(0, 100),
          autoArchiveDuration: 10080,
          reason: `Claude Code session ${sessionId}`,
        });
        isNewThread = true;
        log.info(`[ChannelManager] Created thread "${threadName}" for session ${sessionId}`);
      } catch (err: any) {
        log.error('[ChannelManager] Failed to create thread:', err.message);
        return null;
      }
    }

    if (!thread) {
      log.error('[ChannelManager] Thread is null after creation/lookup');
      return null;
    }

    // Add user to thread
    if (this.userId) {
      try {
        await thread.members.add(this.userId);
      } catch (err) {
        // User might already be in thread
      }
    }

    // Only send initial message for new threads
    if (isNewThread) {
      const timestamp = new Date().toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      await thread.send(
        `🚀 **New Session Started**\n<@${this.userId}>\nSession: \`${sessionId}\`\nTime: ${timestamp}\nCWD: \`${cwd}\``
      );
    } else {
      await thread.send(`🔄 **Session Reconnected**`);
    }

    const mapping: ChannelMapping = {
      sessionId,
      channelId: channel.id,
      threadId: thread.id,
      channelName: channel.name,
      threadName: thread.name,
      sessionName,
      cwd,
      status: 'running',
      createdAt: new Date(),
    };

    this.ptyStore.set(sessionId, mapping);
    await this.ptyStore.persistAndSave(sessionId, { sessionId, threadId: thread.id, channelId: channel.id, cwd });

    log.info(`[ChannelManager] Stored session mapping: ${sessionId} -> thread ${thread.id}`);
    return mapping;
  }

  /**
   * Archive a PTY session's thread
   */
  async archiveSession(sessionId: string): Promise<boolean> {
    const mapping = this.ptyStore.get(sessionId);
    if (!mapping) return false;

    try {
      const thread = await this.client.channels.fetch(mapping.threadId);
      if (thread && thread.isThread()) {
        await thread.setArchived(true);
        log.info(`[ChannelManager] Archived thread for session ${sessionId}`);
      }

      mapping.status = 'ended';
      await this.removePersistedMapping(sessionId);
      return true;
    } catch (err: any) {
      log.error('[ChannelManager] Failed to archive thread:', err.message);
      return false;
    }
  }

  /**
   * Remove a persisted PTY mapping (public for startup reconciliation)
   */
  async removePersistedMapping(sessionId: string): Promise<void> {
    this.ptyStore.deletePersisted(sessionId);
    await this.ptyStore.save();

    // Also clean up in-memory if session exists
    if (this.ptyStore.has(sessionId)) {
      this.ptyStore.delete(sessionId);
      log.info(`[ChannelManager] Removed in-memory session mapping for ${sessionId}`);
    }
  }

  getSession(sessionId: string): ChannelMapping | undefined {
    return this.ptyStore.get(sessionId);
  }

  getSessionByThread(threadId: string): string | undefined {
    return this.ptyStore.getByThread(threadId);
  }

  getSessionByChannel(channelId: string): string | undefined {
    // First check if it's a thread
    const sessionFromThread = this.ptyStore.getByThread(channelId);
    if (sessionFromThread) return sessionFromThread;

    // Check if there's an active session in this channel
    for (const [sessionId, mapping] of this.ptyStore.entries()) {
      if (mapping.channelId === channelId && mapping.status !== 'ended') {
        return sessionId;
      }
    }
    return undefined;
  }

  updateStatus(sessionId: string, status: 'running' | 'idle' | 'ended'): void {
    this.ptyStore.updateStatus(sessionId, status);
  }

  updateName(sessionId: string, name: string): void {
    const mapping = this.ptyStore.get(sessionId);
    if (mapping) {
      mapping.sessionName = name;
    }
  }

  getAllActive(): ChannelMapping[] {
    return this.ptyStore.getAllActive();
  }

  getAllPersisted(): PersistedMapping[] {
    return this.ptyStore.getAllPersisted();
  }

  getPersistedMapping(sessionId: string): PersistedMapping | undefined {
    return this.ptyStore.getPersisted(sessionId);
  }

  // ── Claude SDK session methods ────────────────────────

  async createSdkSession(
    sessionId: string,
    sessionName: string,
    cwd: string,
    existingThreadId?: string,
    sdkSessionId?: string,
  ): Promise<ChannelMapping | null> {
    if (!this.initialized) {
      const ready = await this.waitForInit();
      if (!ready) return null;
    }

    if (this.sdkStore.has(sessionId)) {
      return this.sdkStore.get(sessionId)!;
    }

    let threadId = existingThreadId;
    let channelId = '';
    let threadName = '';
    let channelName = '';

    if (existingThreadId) {
      try {
        const thread = await this.client.channels.fetch(existingThreadId);
        if (thread?.isThread()) {
          threadId = thread.id;
          threadName = thread.name;
          channelId = thread.parentId || '';
        }
      } catch {
        log.warn({ existingThreadId }, 'Failed to fetch existing thread for Claude SDK');
        return null;
      }
    } else {
      const channel = await this.getOrCreateChannel(cwd);
      if (!channel) return null;

      channelId = channel.id;
      channelName = channel.name;

      const timestamp = new Date().toLocaleString('ko-KR', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const name = `claude-sdk-${sessionId.slice(0, 8)} - ${timestamp}`;

      try {
        const thread = await channel.threads.create({
          name: name.slice(0, 100),
          autoArchiveDuration: 10080,
          reason: `Claude SDK session ${sessionId}`,
        });
        threadId = thread.id;
        threadName = thread.name;

        if (this.userId) {
          await thread.members.add(this.userId).catch(() => {});
        }

        const startMsg = await thread.send(
          `📡 **Claude SDK Session Starting**\n<@${this.userId}>\nSession: \`${sessionId}\`\nTime: ${timestamp}\nCWD: \`${cwd}\``
        );
        await startMsg.pin().catch(() => {});
      } catch (err: any) {
        log.error({ err: err.message }, 'Failed to create Claude SDK thread');
        return null;
      }
    }

    if (!threadId) return null;

    const mapping: ChannelMapping = {
      sessionId,
      channelId,
      threadId,
      channelName,
      threadName,
      sessionName,
      cwd,
      status: 'idle',
      createdAt: new Date(),
    };

    this.sdkStore.set(sessionId, mapping);
    await this.sdkStore.persistAndSave(sessionId, {
      sessionId,
      sdkSessionId: sdkSessionId || sessionId,
      threadId,
      channelId,
      cwd,
    });

    log.info({ sessionId, threadId }, 'Claude SDK session mapping stored');
    return mapping;
  }

  getSdkSession(sessionId: string): ChannelMapping | undefined {
    return this.sdkStore.get(sessionId);
  }

  getSdkSessionByThread(threadId: string): string | undefined {
    return this.sdkStore.getByThread(threadId);
  }

  updateSdkStatus(sessionId: string, status: 'running' | 'idle' | 'ended'): void {
    this.sdkStore.updateStatus(sessionId, status);
  }

  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const persisted = this.sdkStore.getPersisted(sessionId);
    if (persisted) {
      persisted.sdkSessionId = sdkSessionId;
      void this.sdkStore.save();
    }
  }

  getPersistedSdkMappings(): PersistedMapping[] {
    return this.sdkStore.getAllPersisted();
  }

  async archiveSdkSession(sessionId: string): Promise<boolean> {
    const mapping = this.sdkStore.get(sessionId);
    const persisted = this.sdkStore.getPersisted(sessionId);

    // Handle both in-memory and persisted-only sessions (e.g. after bot restart)
    if (!mapping && !persisted) return false;

    const threadId = mapping?.threadId || persisted?.threadId;

    if (mapping) {
      mapping.status = 'ended';
    }

    if (threadId) {
      // Only archive thread if no Codex session is active in it
      const codexSessionId = this.codexStore.getByThread(threadId);
      const codexMapping = codexSessionId ? this.codexStore.get(codexSessionId) : undefined;
      const codexActive = codexMapping && codexMapping.status !== 'ended';

      if (!codexActive) {
        try {
          const thread = await this.client.channels.fetch(threadId);
          if (thread?.isThread()) {
            await thread.setArchived(true);
          }
        } catch (err: any) {
          log.error({ err: err.message }, 'Failed to archive Claude SDK thread');
        }
      }

      this.sdkStore.deleteThread(threadId);
    }

    this.sdkStore.delete(sessionId);
    await this.sdkStore.deletePersistedAndSave(sessionId);
    return true;
  }

  /**
   * SDK has custom load logic: dedup by thread, skip broken mappings, restore in-memory sessions
   */
  private async loadSdkMappings(): Promise<void> {
    try {
      const data = await readFile(SDK_MAPPINGS_FILE, 'utf-8');
      const mappings: PersistedMapping[] = JSON.parse(data);
      let cleaned = 0;

      // Deduplicate: keep only the latest mapping per thread
      const latestByThread = new Map<string, PersistedMapping>();
      for (const m of mappings) {
        if (m.threadId) {
          latestByThread.set(m.threadId, m); // last one wins (newest)
        }
      }

      for (const m of latestByThread.values()) {
        // Skip broken mappings where sdkSessionId was never updated
        if (m.sdkSessionId === m.sessionId) {
          log.warn({ sessionId: m.sessionId, threadId: m.threadId }, 'Skipping broken SDK mapping (sdkSessionId === sessionId)');
          cleaned++;
          continue;
        }

        this.sdkStore.setPersisted(m.sessionId, m);
        this.sdkStore.setThread(m.threadId!, m.sessionId);

        // Restore in-memory session mapping so getClaudeSdkThread() works
        // after bot restart (lazy resume needs this to route SDK messages to Discord)
        this.sdkStore.set(m.sessionId, {
          sessionId: m.sessionId,
          channelId: m.channelId,
          threadId: m.threadId!,
          channelName: '',
          threadName: '',
          sessionName: '',
          cwd: m.cwd,
          status: 'idle',
          createdAt: new Date(),
        });
      }

      log.info(`Loaded ${this.sdkStore.persistedSize()} persisted Claude SDK mappings (cleaned ${cleaned} broken, deduped from ${mappings.length})`);

      // Save cleaned mappings back to disk
      if (cleaned > 0 || mappings.length !== this.sdkStore.persistedSize()) {
        await this.sdkStore.save();
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        log.error({ err: err.message }, 'Error loading SDK mappings');
      }
    }
  }

  // ── Codex session methods ─────────────────────────────

  async createCodexSession(
    sessionId: string,
    sessionName: string,
    cwd: string,
    existingThreadId?: string,
  ): Promise<ChannelMapping | null> {
    if (!this.initialized) {
      const ready = await this.waitForInit();
      if (!ready) return null;
    }

    if (this.codexStore.has(sessionId)) {
      return this.codexStore.get(sessionId)!;
    }

    let threadId = existingThreadId;
    let channelId = '';
    let threadName = '';
    let channelName = '';

    if (existingThreadId) {
      try {
        const thread = await this.client.channels.fetch(existingThreadId);
        if (thread?.isThread()) {
          threadId = thread.id;
          threadName = thread.name;
          channelId = thread.parentId || '';
          await thread.send(`🤖 **Codex session joined this thread**\nCWD: \`${cwd}\``);
        }
      } catch {
        log.warn({ existingThreadId }, 'Failed to fetch existing thread for Codex');
        return null;
      }
    } else {
      const channel = await this.getOrCreateChannel(cwd);
      if (!channel) return null;

      channelId = channel.id;
      channelName = channel.name;

      const timestamp = new Date().toLocaleString('ko-KR', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      const name = `codex-${sessionId.slice(0, 8)} - ${timestamp}`;

      try {
        const thread = await channel.threads.create({
          name: name.slice(0, 100),
          autoArchiveDuration: 10080,
          reason: `Codex session ${sessionId}`,
        });
        threadId = thread.id;
        threadName = thread.name;

        if (this.userId) {
          await thread.members.add(this.userId).catch(() => {});
        }

        await thread.send(
          `🤖 **Codex Session Started**\n<@${this.userId}>\nSession: \`${sessionId}\`\nTime: ${timestamp}\nCWD: \`${cwd}\``
        );
      } catch (err: any) {
        log.error({ err: err.message }, 'Failed to create Codex thread');
        return null;
      }
    }

    if (!threadId) return null;

    const mapping: ChannelMapping = {
      sessionId,
      channelId,
      threadId,
      channelName,
      threadName,
      sessionName,
      cwd,
      status: 'running',
      createdAt: new Date(),
    };

    this.codexStore.set(sessionId, mapping);
    await this.codexStore.persistAndSave(sessionId, { sessionId, threadId, channelId, cwd });

    log.info({ sessionId, threadId }, 'Codex session mapping stored');
    return mapping;
  }

  getCodexSession(sessionId: string): ChannelMapping | undefined {
    return this.codexStore.get(sessionId);
  }

  updateCodexSessionId(oldId: string, newId: string): void {
    const mapping = this.codexStore.get(oldId);
    if (!mapping) return;

    mapping.sessionId = newId;
    this.codexStore.delete(oldId);
    this.codexStore.set(newId, mapping);

    // Update persisted mappings
    const persisted = this.codexStore.getPersisted(oldId);
    if (persisted) {
      this.codexStore.deletePersisted(oldId);
      persisted.sessionId = newId;
      this.codexStore.setPersisted(newId, persisted);
      this.codexStore.save();
    }

    log.info({ oldId, newId }, 'Updated Codex session ID');
  }

  setCodexThreadId(sessionId: string, codexThreadId: string): void {
    const persisted = this.codexStore.getPersisted(sessionId);
    if (persisted) {
      persisted.codexThreadId = codexThreadId;
      this.codexStore.save();
      log.info({ sessionId, codexThreadId }, 'Stored Codex SDK thread ID');
    }
  }

  getPersistedCodexMappings(): PersistedMapping[] {
    return this.codexStore.getAllPersisted();
  }

  restoreCodexSessionMapping(persisted: PersistedMapping): void {
    const mapping: ChannelMapping = {
      sessionId: persisted.sessionId,
      channelId: persisted.channelId,
      threadId: persisted.threadId,
      channelName: '',
      threadName: '',
      sessionName: 'codex-restored',
      cwd: persisted.cwd,
      status: 'idle',
      createdAt: new Date(),
    };

    this.codexStore.set(persisted.sessionId, mapping);
    log.info({ sessionId: persisted.sessionId, threadId: persisted.threadId }, 'Restored Codex session mapping');
  }

  getCodexSessionByThread(threadId: string): string | undefined {
    return this.codexStore.getByThread(threadId);
  }

  async archiveCodexSession(sessionId: string): Promise<boolean> {
    const mapping = this.codexStore.get(sessionId);
    if (!mapping) return false;

    mapping.status = 'ended';

    // Only archive thread if no Claude session (PTY or SDK) is active in it
    const ptyClaudeInThread = this.ptyStore.getByThread(mapping.threadId);
    const ptyClaudeMapping = ptyClaudeInThread ? this.ptyStore.get(ptyClaudeInThread) : undefined;
    const sdkClaudeInThread = this.sdkStore.getByThread(mapping.threadId);
    const sdkClaudeMapping = sdkClaudeInThread ? this.sdkStore.get(sdkClaudeInThread) : undefined;
    const claudeActive =
      (ptyClaudeMapping && ptyClaudeMapping.status !== 'ended') ||
      (sdkClaudeMapping && sdkClaudeMapping.status !== 'ended');

    if (!claudeActive) {
      try {
        const thread = await this.client.channels.fetch(mapping.threadId);
        if (thread?.isThread()) {
          await thread.setArchived(true);
        }
      } catch (err: any) {
        log.error({ err: err.message }, 'Failed to archive Codex thread');
      }
    }

    this.codexStore.delete(sessionId);
    await this.codexStore.deletePersistedAndSave(sessionId);
    return true;
  }

  /**
   * Validate persisted Codex mappings against actual Discord thread state.
   * Removes stale entries (no codexThreadId, thread deleted, thread archived).
   */
  async validateAndCleanCodexMappings(): Promise<PersistedMapping[]> {
    const valid: PersistedMapping[] = [];
    const stale: string[] = [];

    for (const [sessionId, mapping] of this.codexStore.persistedEntries()) {
      // Skip mappings without codexThreadId (never completed first turn)
      if (!mapping.codexThreadId) {
        stale.push(sessionId);
        log.info({ sessionId }, 'Removing Codex mapping: no codexThreadId');
        continue;
      }

      // Validate Discord thread exists and is not archived
      try {
        const thread = await this.client.channels.fetch(mapping.threadId);
        if (!thread?.isThread()) {
          stale.push(sessionId);
          log.info({ sessionId, threadId: mapping.threadId }, 'Removing Codex mapping: thread not found or not a thread');
          continue;
        }
        if (thread.archived) {
          stale.push(sessionId);
          log.info({ sessionId, threadId: mapping.threadId }, 'Removing Codex mapping: thread archived');
          continue;
        }
        valid.push(mapping);
      } catch {
        stale.push(sessionId);
        log.info({ sessionId, threadId: mapping.threadId }, 'Removing Codex mapping: failed to fetch thread');
      }
    }

    if (stale.length > 0) {
      for (const sessionId of stale) {
        this.codexStore.deletePersisted(sessionId);
      }
      await this.codexStore.save();
      log.info({ removed: stale.length, remaining: valid.length }, 'Cleaned stale Codex mappings');
    }

    return valid;
  }

  // ── Agent session store (generic agents: Gemma, GLM, Qwen, etc.) ──

  async createAgentSession(
    sessionId: string,
    sessionName: string,
    cwd: string,
    modelAlias: string,
    modelDisplayName: string,
  ): Promise<ChannelMapping | null> {
    if (!this.initialized) {
      const ready = await this.waitForInit();
      if (!ready) return null;
    }

    if (this.agentStore.has(sessionId)) {
      return this.agentStore.get(sessionId)!;
    }

    const channel = await this.getOrCreateChannel(cwd);
    if (!channel) return null;

    const timestamp = new Date().toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const name = `${modelAlias}-${sessionId.slice(0, 8)} - ${timestamp}`;

    let threadId = '';
    try {
      const thread = await channel.threads.create({
        name: name.slice(0, 100),
        autoArchiveDuration: 10080,
        reason: `Agent session ${sessionId} (${modelDisplayName})`,
      });
      threadId = thread.id;

      if (this.userId) {
        await thread.members.add(this.userId).catch(() => {});
      }

      const startMsg = await thread.send(
        `🤖 **${modelDisplayName} Session Starting**\n<@${this.userId}>\nSession: \`${sessionId}\`\nTime: ${timestamp}\nCWD: \`${cwd}\``
      );
      await startMsg.pin().catch(() => {});
    } catch (err: any) {
      log.error({ err: err.message }, 'Failed to create agent thread');
      return null;
    }

    const mapping: ChannelMapping = {
      sessionId,
      channelId: channel.id,
      threadId,
      channelName: channel.name,
      threadName: name,
      sessionName,
      cwd,
      status: 'idle',
      createdAt: new Date(),
    };

    this.agentStore.set(sessionId, mapping);
    await this.agentStore.persistAndSave(sessionId, {
      sessionId,
      threadId,
      channelId: channel.id,
      cwd,
      modelAlias,
    });

    log.info({ sessionId, threadId, model: modelAlias }, 'Agent session mapping stored');
    return mapping;
  }

  /**
   * Rebuild in-memory agent mapping from persisted data (for bot restart restore)
   */
  restoreAgentSessionMapping(persisted: PersistedMapping): void {
    if (this.agentStore.has(persisted.sessionId)) return;
    const mapping: ChannelMapping = {
      sessionId: persisted.sessionId,
      channelId: persisted.channelId,
      threadId: persisted.threadId,
      channelName: '',
      threadName: '',
      sessionName: persisted.modelAlias || '',
      cwd: persisted.cwd,
      status: 'idle',
      createdAt: new Date(),
    };
    this.agentStore.set(persisted.sessionId, mapping);
    log.info({ sessionId: persisted.sessionId, threadId: persisted.threadId }, 'Restored agent session mapping');
  }

  getAgentSession(sessionId: string): ChannelMapping | undefined {
    return this.agentStore.get(sessionId);
  }

  getAgentSessionByThread(threadId: string): string | undefined {
    return this.agentStore.getByThread(threadId);
  }

  updateAgentStatus(sessionId: string, status: 'running' | 'idle' | 'ended'): void {
    this.agentStore.updateStatus(sessionId, status);
  }

  async archiveAgentSession(sessionId: string): Promise<boolean> {
    const mapping = this.agentStore.get(sessionId);
    if (!mapping) return false;

    mapping.status = 'ended';
    this.agentStore.deletePersisted(sessionId);
    await this.agentStore.save();
    this.agentStore.delete(sessionId);

    // Archive thread if no other sessions use it
    try {
      const thread = await this.client.channels.fetch(mapping.threadId);
      if (thread?.isThread()) {
        const hasOthers = this.ptyStore.getByThread(mapping.threadId)
          || this.sdkStore.getByThread(mapping.threadId)
          || this.codexStore.getByThread(mapping.threadId);
        if (!hasOthers) {
          await thread.setArchived(true);
        }
      }
    } catch { /* ignore */ }

    log.info({ sessionId }, 'Agent session archived');
    return true;
  }

  getPersistedAgentMappings(): PersistedMapping[] {
    return this.agentStore.getAllPersisted();
  }

  // ── Cross-store helpers ───────────────────────────────

  /**
   * Get which agents are active in a thread
   */
  getAgentsInThread(threadId: string): { claude?: string; codex?: string; agent?: string } {
    return {
      claude: this.ptyStore.getByThread(threadId) || this.sdkStore.getByThread(threadId),
      codex: this.codexStore.getByThread(threadId),
      agent: this.agentStore.getByThread(threadId),
    };
  }
}
