import type { Client, TextChannel, CategoryChannel, Guild, ThreadChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { discordLogger as log } from '../utils/logger.js';

const MAPPINGS_DIR = join(homedir(), '.sleep-code');
const MAPPINGS_FILE = join(MAPPINGS_DIR, 'session-mappings.json');
const CODEX_MAPPINGS_FILE = join(MAPPINGS_DIR, 'codex-session-mappings.json');
const SDK_MAPPINGS_FILE = join(MAPPINGS_DIR, 'sdk-session-mappings.json');

export interface PersistedMapping {
  sessionId: string;
  threadId: string;
  channelId: string;
  cwd: string;
  codexThreadId?: string; // Codex SDK thread ID for resumeThread()
  sdkSessionId?: string; // Claude Agent SDK session ID for resume()
}

export interface ChannelMapping {
  sessionId: string;
  channelId: string;    // CWD-based channel
  threadId: string;     // Session-specific thread
  channelName: string;
  threadName: string;
  sessionName: string;
  cwd: string;
  status: 'running' | 'idle' | 'ended';
  createdAt: Date;
}

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
  private sessions = new Map<string, ChannelMapping>();       // sessionId -> mapping
  private threadToSession = new Map<string, string>();        // threadId -> sessionId
  private cwdToChannel = new Map<string, string>();           // cwd -> channelId
  private persistedMappings = new Map<string, PersistedMapping>(); // sessionId -> persisted data

  // Codex session tracking (parallel to Claude)
  private codexSessions = new Map<string, ChannelMapping>();       // sessionId -> mapping
  private threadToCodexSession = new Map<string, string>();        // threadId -> sessionId
  private codexPersistedMappings = new Map<string, PersistedMapping>();

  // Claude SDK session tracking (parallel to PTY Claude)
  private sdkSessions = new Map<string, ChannelMapping>();
  private threadToSdkSession = new Map<string, string>();
  private sdkPersistedMappings = new Map<string, PersistedMapping>();
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

  /**
   * Load persisted session mappings from file
   */
  private async loadMappings(): Promise<void> {
    try {
      const data = await readFile(MAPPINGS_FILE, 'utf-8');
      const mappings: PersistedMapping[] = JSON.parse(data);
      for (const m of mappings) {
        this.persistedMappings.set(m.sessionId, m);
      }
      log.info(`[ChannelManager] Loaded ${mappings.length} persisted session mappings`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        log.error('[ChannelManager] Error loading mappings:', err.message);
      }
    }
  }

  /**
   * Save session mappings to file
   */
  private async saveMappings(): Promise<void> {
    try {
      await mkdir(MAPPINGS_DIR, { recursive: true });
      const mappings = Array.from(this.persistedMappings.values());
      await writeFile(MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
    } catch (err: any) {
      log.error('[ChannelManager] Error saving mappings:', err.message);
    }
  }

  /**
   * Add or update a persisted mapping
   */
  private async persistMapping(sessionId: string, threadId: string, channelId: string, cwd: string): Promise<void> {
    this.persistedMappings.set(sessionId, { sessionId, threadId, channelId, cwd });
    await this.saveMappings();
  }

  /**
   * Remove a persisted mapping (public for startup reconciliation)
   * Also cleans up in-memory maps if the session exists there
   */
  async removePersistedMapping(sessionId: string): Promise<void> {
    // Clean up persisted mapping
    this.persistedMappings.delete(sessionId);
    await this.saveMappings();

    // Also clean up in-memory maps if session exists (Issue 8)
    const session = this.sessions.get(sessionId);
    if (session) {
      this.threadToSession.delete(session.threadId);
      this.sessions.delete(sessionId);
      log.info(`[ChannelManager] Removed in-memory session mapping for ${sessionId}`);
    }
  }

  /**
   * Wait for initialization to complete (with timeout)
   */
  async waitForInit(timeoutMs = 30000): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initPromise) {
      await this.initPromise;
      return this.initialized;
    }

    // Wait for initialization to start (polling)
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
    // Load persisted session mappings first
    await this.loadMappings();
    await this.loadCodexMappings();
    await this.loadSdkMappings();

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

      // Check if name exists
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
      // Fetch active and archived threads
      const activeThreads = await channel.threads.fetchActive();
      const archivedThreads = await channel.threads.fetchArchived({ type: 'public' });

      // Look for thread that starts with sessionId
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

  /**
   * Create a session (channel + thread)
   */
  async createSession(
    sessionId: string,
    sessionName: string,
    cwd: string
  ): Promise<ChannelMapping | null> {
    // Wait for initialization if not ready
    if (!this.initialized) {
      log.info(`[ChannelManager] Waiting for initialization before creating session ${sessionId}`);
      const ready = await this.waitForInit();
      if (!ready) {
        log.error('[ChannelManager] Initialization failed, cannot create session');
        return null;
      }
    }

    // Check if session already exists in memory
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    // Get or create the channel for this CWD
    const channel = await this.getOrCreateChannel(cwd);
    if (!channel) return null;

    // Try to find existing thread from persisted mapping (by threadId)
    let thread: ThreadChannel | null = null;
    let isNewThread = false;
    const persisted = this.persistedMappings.get(sessionId);

    if (persisted) {
      try {
        const existingThread = await this.client.channels.fetch(persisted.threadId);
        if (existingThread?.isThread()) {
          thread = existingThread;
          // Unarchive if archived
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
      // Create a new standalone thread
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
          autoArchiveDuration: 10080, // 7 days
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

    // Add user to thread so it appears in their sidebar
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
      // Notify reconnection
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

    this.sessions.set(sessionId, mapping);
    this.threadToSession.set(thread.id, sessionId);

    // Persist the mapping for future reconnects
    await this.persistMapping(sessionId, thread.id, channel.id, cwd);

    log.info(`[ChannelManager] Stored session mapping: ${sessionId} -> thread ${thread.id}`);

    return mapping;
  }

  /**
   * Archive a session's thread
   */
  async archiveSession(sessionId: string): Promise<boolean> {
    const mapping = this.sessions.get(sessionId);
    if (!mapping) return false;

    try {
      const thread = await this.client.channels.fetch(mapping.threadId);
      if (thread && thread.isThread()) {
        await thread.setArchived(true);
        log.info(`[ChannelManager] Archived thread for session ${sessionId}`);
      }

      // Update status and remove persisted mapping
      mapping.status = 'ended';
      await this.removePersistedMapping(sessionId);
      return true;
    } catch (err: any) {
      log.error('[ChannelManager] Failed to archive thread:', err.message);
      return false;
    }
  }

  getSession(sessionId: string): ChannelMapping | undefined {
    return this.sessions.get(sessionId);
  }


  getSessionByThread(threadId: string): string | undefined {
    return this.threadToSession.get(threadId);
  }

  // Also check parent channel for messages
  getSessionByChannel(channelId: string): string | undefined {
    // First check if it's a thread
    const sessionFromThread = this.threadToSession.get(channelId);
    if (sessionFromThread) return sessionFromThread;

    // Check if there's an active session in this channel
    for (const [sessionId, mapping] of this.sessions) {
      if (mapping.channelId === channelId && mapping.status !== 'ended') {
        return sessionId;
      }
    }
    return undefined;
  }

  updateStatus(sessionId: string, status: 'running' | 'idle' | 'ended'): void {
    const mapping = this.sessions.get(sessionId);
    if (mapping) {
      mapping.status = status;
    }
  }

  updateName(sessionId: string, name: string): void {
    const mapping = this.sessions.get(sessionId);
    if (mapping) {
      mapping.sessionName = name;
    }
  }

  getAllActive(): ChannelMapping[] {
    return Array.from(this.sessions.values()).filter((s) => s.status !== 'ended');
  }

  /**
   * Get all persisted mappings (for fallback when session not in memory)
   */
  getAllPersisted(): PersistedMapping[] {
    return Array.from(this.persistedMappings.values());
  }

  /**
   * Get a specific persisted mapping by sessionId
   */
  getPersistedMapping(sessionId: string): PersistedMapping | undefined {
    return this.persistedMappings.get(sessionId);
  }

  // ── Claude SDK session methods ──────────────────────────────

  async createSdkSession(
    sessionId: string,
    sessionName: string,
    cwd: string,
    existingThreadId?: string,
  ): Promise<ChannelMapping | null> {
    if (!this.initialized) {
      const ready = await this.waitForInit();
      if (!ready) return null;
    }

    if (this.sdkSessions.has(sessionId)) {
      return this.sdkSessions.get(sessionId)!;
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

        await thread.send(
          `📡 **Claude SDK Session Starting**\n<@${this.userId}>\nSession: \`${sessionId}\`\nTime: ${timestamp}\nCWD: \`${cwd}\``
        );
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

    this.sdkSessions.set(sessionId, mapping);
    this.threadToSdkSession.set(threadId, sessionId);
    this.sdkPersistedMappings.set(sessionId, {
      sessionId,
      sdkSessionId: sessionId,
      threadId,
      channelId,
      cwd,
    });
    await this.saveSdkMappings();

    log.info({ sessionId, threadId }, 'Claude SDK session mapping stored');
    return mapping;
  }

  getSdkSession(sessionId: string): ChannelMapping | undefined {
    return this.sdkSessions.get(sessionId);
  }

  getSdkSessionByThread(threadId: string): string | undefined {
    return this.threadToSdkSession.get(threadId);
  }

  updateSdkStatus(sessionId: string, status: 'running' | 'idle' | 'ended'): void {
    const mapping = this.sdkSessions.get(sessionId);
    if (mapping) {
      mapping.status = status;
    }
  }

  setSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const persisted = this.sdkPersistedMappings.get(sessionId);
    if (persisted) {
      persisted.sdkSessionId = sdkSessionId;
      void this.saveSdkMappings();
    }
  }

  getPersistedSdkMappings(): PersistedMapping[] {
    return Array.from(this.sdkPersistedMappings.values());
  }

  async archiveSdkSession(sessionId: string): Promise<boolean> {
    const mapping = this.sdkSessions.get(sessionId);
    const persisted = this.sdkPersistedMappings.get(sessionId);

    // Handle both in-memory and persisted-only sessions (e.g. after bot restart)
    if (!mapping && !persisted) return false;

    const threadId = mapping?.threadId || persisted?.threadId;

    if (mapping) {
      mapping.status = 'ended';
    }

    if (threadId) {
      const codexSessionId = this.threadToCodexSession.get(threadId);
      const codexMapping = codexSessionId ? this.codexSessions.get(codexSessionId) : undefined;
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

      this.threadToSdkSession.delete(threadId);
    }

    this.sdkSessions.delete(sessionId);
    this.sdkPersistedMappings.delete(sessionId);
    await this.saveSdkMappings();
    return true;
  }

  private async saveSdkMappings(): Promise<void> {
    try {
      await mkdir(MAPPINGS_DIR, { recursive: true });
      const mappings = Array.from(this.sdkPersistedMappings.values());
      await writeFile(SDK_MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
    } catch (err: any) {
      log.error({ err: err.message }, 'Error saving SDK mappings');
    }
  }

  private async loadSdkMappings(): Promise<void> {
    try {
      const data = await readFile(SDK_MAPPINGS_FILE, 'utf-8');
      const mappings: PersistedMapping[] = JSON.parse(data);
      for (const m of mappings) {
        this.sdkPersistedMappings.set(m.sessionId, m);
      }
      log.info(`Loaded ${mappings.length} persisted Claude SDK mappings`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        log.error({ err: err.message }, 'Error loading SDK mappings');
      }
    }
  }

  // ── Codex session methods ───────────────────────────────────

  /**
   * Create a Codex session mapping, optionally reusing an existing thread
   */
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

    if (this.codexSessions.has(sessionId)) {
      return this.codexSessions.get(sessionId)!;
    }

    let threadId = existingThreadId;
    let channelId = '';
    let threadName = '';
    let channelName = '';

    if (existingThreadId) {
      // Reuse an existing thread (multi-agent scenario)
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
      // Create new channel + thread (same as Claude flow)
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

    this.codexSessions.set(sessionId, mapping);
    this.threadToCodexSession.set(threadId, sessionId);

    // Persist
    this.codexPersistedMappings.set(sessionId, { sessionId, threadId, channelId, cwd });
    await this.saveCodexMappings();

    log.info({ sessionId, threadId }, 'Codex session mapping stored');
    return mapping;
  }

  getCodexSession(sessionId: string): ChannelMapping | undefined {
    return this.codexSessions.get(sessionId);
  }

  /**
   * Update a Codex session's ID (used when 'pending' placeholder is replaced with real ID)
   */
  updateCodexSessionId(oldId: string, newId: string): void {
    const mapping = this.codexSessions.get(oldId);
    if (!mapping) return;

    mapping.sessionId = newId;
    this.codexSessions.delete(oldId);
    this.codexSessions.set(newId, mapping);

    // Update thread mapping
    this.threadToCodexSession.set(mapping.threadId, newId);

    // Update persisted mappings
    const persisted = this.codexPersistedMappings.get(oldId);
    if (persisted) {
      this.codexPersistedMappings.delete(oldId);
      persisted.sessionId = newId;
      this.codexPersistedMappings.set(newId, persisted);
      this.saveCodexMappings();
    }

    log.info({ oldId, newId }, 'Updated Codex session ID');
  }

  /**
   * Store Codex SDK thread ID for session persistence (needed for resumeThread)
   */
  setCodexThreadId(sessionId: string, codexThreadId: string): void {
    const persisted = this.codexPersistedMappings.get(sessionId);
    if (persisted) {
      persisted.codexThreadId = codexThreadId;
      this.saveCodexMappings();
      log.info({ sessionId, codexThreadId }, 'Stored Codex SDK thread ID');
    }
  }

  /**
   * Get all persisted Codex mappings (for session restoration on startup)
   */
  getPersistedCodexMappings(): PersistedMapping[] {
    return Array.from(this.codexPersistedMappings.values());
  }

  /**
   * Restore in-memory Codex session mapping from persisted data (after PM2 restart)
   */
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

    this.codexSessions.set(persisted.sessionId, mapping);
    this.threadToCodexSession.set(persisted.threadId, persisted.sessionId);
    log.info({ sessionId: persisted.sessionId, threadId: persisted.threadId }, 'Restored Codex session mapping');
  }

  getCodexSessionByThread(threadId: string): string | undefined {
    return this.threadToCodexSession.get(threadId);
  }

  /**
   * Get which agents are active in a thread
   */
  getAgentsInThread(threadId: string): { claude?: string; codex?: string } {
    return {
      claude: this.threadToSession.get(threadId) || this.threadToSdkSession.get(threadId),
      codex: this.threadToCodexSession.get(threadId),
    };
  }

  async archiveCodexSession(sessionId: string): Promise<boolean> {
    const mapping = this.codexSessions.get(sessionId);
    if (!mapping) return false;

    mapping.status = 'ended';

    // Only archive thread if no Claude session is active in it
    const ptyClaudeInThread = this.threadToSession.get(mapping.threadId);
    const ptyClaudeMapping = ptyClaudeInThread ? this.sessions.get(ptyClaudeInThread) : undefined;
    const sdkClaudeInThread = this.threadToSdkSession.get(mapping.threadId);
    const sdkClaudeMapping = sdkClaudeInThread ? this.sdkSessions.get(sdkClaudeInThread) : undefined;
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

    this.threadToCodexSession.delete(mapping.threadId);
    this.codexSessions.delete(sessionId);
    this.codexPersistedMappings.delete(sessionId);
    await this.saveCodexMappings();
    return true;
  }

  private async saveCodexMappings(): Promise<void> {
    try {
      await mkdir(MAPPINGS_DIR, { recursive: true });
      const mappings = Array.from(this.codexPersistedMappings.values());
      await writeFile(CODEX_MAPPINGS_FILE, JSON.stringify(mappings, null, 2));
    } catch (err: any) {
      log.error({ err: err.message }, 'Error saving Codex mappings');
    }
  }

  /**
   * Validate persisted Codex mappings against actual Discord thread state.
   * Removes stale entries (no codexThreadId, thread deleted, thread archived).
   * Returns only valid mappings that should be restored.
   */
  async validateAndCleanCodexMappings(): Promise<PersistedMapping[]> {
    const valid: PersistedMapping[] = [];
    const stale: string[] = [];

    for (const [sessionId, mapping] of this.codexPersistedMappings) {
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

    // Clean up stale mappings
    if (stale.length > 0) {
      for (const sessionId of stale) {
        this.codexPersistedMappings.delete(sessionId);
      }
      await this.saveCodexMappings();
      log.info({ removed: stale.length, remaining: valid.length }, 'Cleaned stale Codex mappings');
    }

    return valid;
  }

  private async loadCodexMappings(): Promise<void> {
    try {
      const data = await readFile(CODEX_MAPPINGS_FILE, 'utf-8');
      const mappings: PersistedMapping[] = JSON.parse(data);
      for (const m of mappings) {
        this.codexPersistedMappings.set(m.sessionId, m);
      }
      log.info(`Loaded ${mappings.length} persisted Codex mappings`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        log.error({ err: err.message }, 'Error loading Codex mappings');
      }
    }
  }
}
