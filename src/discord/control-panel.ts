/**
 * Control Panel
 *
 * Creates/maintains a #sleep-code-control channel with persistent control buttons.
 * - Kill All: Force-interrupt all active Claude SDK, PTY, and Codex sessions.
 */

import {
  type Client,
  type TextChannel,
  type Guild,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from 'discord.js';
import { discordLogger as log } from '../utils/logger.js';
import type { InteractionContext } from './interactions/types.js';

const CHANNEL_NAME = 'sleep-code-control';
const CATEGORY_NAME = 'Sleep Code Sessions';

export class ControlPanel {
  private client: Client;
  private channel: TextChannel | null = null;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * Find or create #sleep-code-control and post the control panel message.
   */
  async initialize(): Promise<void> {
    const guild = this.client.guilds.cache.first();
    if (!guild) {
      log.warn('No guild found — cannot create control panel');
      return;
    }

    this.channel = await this.findOrCreateChannel(guild);
    if (!this.channel) return;

    // Post or update the control panel message
    await this.postControlPanel();
    log.info({ channelId: this.channel.id }, 'Control panel initialized');
  }

  private async findOrCreateChannel(guild: Guild): Promise<TextChannel | null> {
    // Check if channel already exists
    const existing = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildText && ch.name === CHANNEL_NAME,
    ) as TextChannel | undefined;

    if (existing) return existing;

    // Find the Sleep Code Sessions category
    const category = guild.channels.cache.find(
      (ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === CATEGORY_NAME.toLowerCase(),
    );

    const categoryId = category?.id;

    try {
      const channel = await guild.channels.create({
        name: CHANNEL_NAME,
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: 'Sleep Code control panel — session management buttons',
      }) as unknown as TextChannel;

      return channel;
    } catch (err) {
      log.error({ err }, 'Failed to create control panel channel');
      return null;
    }
  }

  private async postControlPanel(): Promise<void> {
    if (!this.channel) return;

    // Delete old panel messages and re-post fresh
    try {
      const fetched = await this.channel.messages.fetch({ limit: 10 });
      const msgs = [...fetched.values()];
      for (const msg of msgs) {
        if (msg.author.id === this.client.user?.id && msg.components.length > 0) {
          await msg.delete().catch(() => {});
        }
      }
    } catch {
      // Ignore fetch errors
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('control:kill_all')
        .setLabel('Interrupt All')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('⛔'),
    );

    await this.channel.send({
      content: '## Sleep Code Control Panel\nAll active sessions can be managed from here.',
      components: [row],
    });
  }
}

/**
 * Handle the Kill All button press
 */
export async function handleKillAllButton(
  interaction: ButtonInteraction,
  context: InteractionContext,
): Promise<void> {
  await interaction.deferReply();

  const interrupted: string[] = [];

  // 1. Interrupt all Claude SDK sessions
  if (context.claudeSdkSessionManager) {
    const sdkSessions = context.claudeSdkSessionManager.getAllSessions();
    for (const session of sdkSessions) {
      if (session.status === 'running') {
        context.claudeSdkSessionManager.interruptSession(session.id);
        interrupted.push(`SDK: \`${session.id.slice(0, 8)}\` (${session.cwd.split('/').pop()})`);
      }
    }
  }

  // 2. Interrupt all PTY sessions
  if (context.sessionManager) {
    const ptySessions = context.sessionManager.getAllSessions();
    for (const session of ptySessions) {
      if (session.status === 'running') {
        context.sessionManager.sendInput(session.id, '\x03', false); // Ctrl+C
        interrupted.push(`PTY: \`${session.id.slice(0, 8)}\` (${session.name || 'unnamed'})`);
      }
    }
  }

  // 3. Interrupt all Codex sessions
  if (context.codexSessionManager) {
    const codexSessions = context.codexSessionManager.getAllSessions();
    for (const session of codexSessions) {
      if (session.status === 'running') {
        context.codexSessionManager.interruptSession(session.id);
        interrupted.push(`Codex: \`${session.id.slice(0, 8)}\``);
      }
    }
  }

  if (interrupted.length === 0) {
    await interaction.editReply('No running sessions to interrupt.');
  } else {
    await interaction.editReply(
      `⛔ **Interrupted ${interrupted.length} session(s):**\n${interrupted.map((k) => `- ${k}`).join('\n')}`,
    );
  }
}
