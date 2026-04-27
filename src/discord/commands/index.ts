/**
 * Command definitions and router
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { handleHelp } from './help.js';
import { handleSessions } from './sessions.js';
import { handleBackground, handleInterrupt, handleMode, handleCompact, handleModel } from './controls.js';
import { handleYoloSleep, handlePanel } from './yolo.js';
import { handleClaude } from './claude.js';
import { handleCodex } from './codex.js';
import { handleChat } from './chat.js';
import { handleStatus } from './status.js';
import { handleMemory, type MemoryCommandContext } from './memory.js';
import { handleSettings } from './settings.js';
import type { CommandContext } from './types.js';

/**
 * All slash command definitions
 */
export const commands = [
  new SlashCommandBuilder()
    .setName('commands')
    .setDescription('List all available slash commands'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),
  new SlashCommandBuilder()
    .setName('background')
    .setDescription('Send Claude to background mode (Ctrl+B)'),
  new SlashCommandBuilder()
    .setName('interrupt')
    .setDescription('Interrupt Claude (Escape)'),
  new SlashCommandBuilder()
    .setName('mode')
    .setDescription('Toggle Claude mode (Shift+Tab)'),
  new SlashCommandBuilder()
    .setName('sessions')
    .setDescription('List active Claude Code sessions'),
  new SlashCommandBuilder()
    .setName('compact')
    .setDescription('Compact the conversation (/compact)'),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Switch Claude model')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Model name')
        .setRequired(true)
        .addChoices(
          { name: 'Default', value: 'default' },
          { name: 'Opus', value: 'opus' },
          { name: 'Sonnet', value: 'sonnet' },
          { name: 'Haiku', value: 'haiku' },
        )),
  new SlashCommandBuilder()
    .setName('yolo-sleep')
    .setDescription('Toggle YOLO mode - auto-approve all permission requests'),
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Show session control panel with Interrupt and YOLO buttons'),
  // Process management commands
  new SlashCommandBuilder()
    .setName('claude')
    .setDescription('Manage Claude Code sessions')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a new Claude Code session'))
    .addSubcommand(sub =>
      sub.setName('start-sdk')
        .setDescription('Start a Claude session via Agent SDK'))
    .addSubcommand(sub =>
      sub.setName('stop')
        .setDescription('Stop a running Claude Code session'))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show all managed sessions'))
    .addSubcommand(sub =>
      sub.setName('add-dir')
        .setDescription('Add a directory to the whitelist')
        .addStringOption(opt =>
          opt.setName('path')
            .setDescription('Absolute directory path')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('remove-dir')
        .setDescription('Remove a directory from the whitelist'))
    .addSubcommand(sub =>
      sub.setName('list-dirs')
        .setDescription('List all whitelisted directories'))
    .addSubcommand(sub =>
      sub.setName('set-terminal')
        .setDescription('Set terminal app for new sessions'))
    .addSubcommand(sub =>
      sub.setName('restore')
        .setDescription('Restore a dead session in this thread')),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show current thread session status'),
  new SlashCommandBuilder()
    .setName('codex')
    .setDescription('Manage Codex CLI sessions')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a new Codex session'))
    .addSubcommand(sub =>
      sub.setName('stop')
        .setDescription('Stop a running Codex session'))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show all Codex sessions'))
    .addSubcommand(sub =>
      sub.setName('intelligence')
        .setDescription('Change reasoning effort of Codex session in this thread')),
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Manage agent sessions (Gemma, GLM, Qwen, etc.)')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Start a new agent session')
        .addStringOption(opt =>
          opt.setName('model')
            .setDescription('Model alias (gemma4, glm5, glm51, qwen3-coder)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('stop')
        .setDescription('Stop agent session in this thread'))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show all active agent sessions'))
    .addSubcommand(sub =>
      sub.setName('models')
        .setDescription('Show available models and pricing')),
  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Show current settings with tips to change them'),
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('Manage memory collection')
    .addSubcommand(sub =>
      sub.setName('opt-out')
        .setDescription('Disable memory collection')
        .addBooleanOption(opt =>
          opt.setName('global')
            .setDescription('Disable globally (all sessions)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('opt-in')
        .setDescription('Enable memory collection')
        .addBooleanOption(opt =>
          opt.setName('global')
            .setDescription('Enable globally (all sessions)')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show memory system status'))
    .addSubcommand(sub =>
      sub.setName('digest')
        .setDescription('Generate a daily digest now'))
    .addSubcommand(sub =>
      sub.setName('consolidate')
        .setDescription('Run memory consolidation now')),
];

/**
 * /commands — auto-generated list from registered commands
 */
async function handleCommands(interaction: ChatInputCommandInteraction): Promise<void> {
  const lines: string[] = [];

  for (const cmd of commands) {
    const data = cmd.toJSON();
    if (data.name === 'commands') continue; // skip self

    const subs = (data.options || []).filter((o: any) => o.type === 1); // type 1 = SUB_COMMAND
    if (subs.length > 0) {
      for (const sub of subs) {
        lines.push(`\`/${data.name} ${sub.name}\` — ${sub.description}`);
      }
    } else {
      lines.push(`\`/${data.name}\` — ${data.description}`);
    }
  }

  await interaction.reply({
    content: `**Available Commands (${lines.length})**\n${lines.join('\n')}`,
    ephemeral: true,
  });
}

/**
 * Handle slash command interactions
 */
export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const { commandName } = interaction;

  switch (commandName) {
    case 'commands':
      await handleCommands(interaction);
      break;
    case 'help':
      await handleHelp(interaction, context);
      break;
    case 'sessions':
      await handleSessions(interaction, context);
      break;
    case 'background':
      await handleBackground(interaction, context);
      break;
    case 'interrupt':
      await handleInterrupt(interaction, context);
      break;
    case 'mode':
      await handleMode(interaction, context);
      break;
    case 'compact':
      await handleCompact(interaction, context);
      break;
    case 'model':
      await handleModel(interaction, context);
      break;
    case 'yolo-sleep':
      await handleYoloSleep(interaction, context);
      break;
    case 'panel':
      await handlePanel(interaction, context);
      break;
    case 'claude':
      await handleClaude(interaction, context);
      break;
    case 'status':
      await handleStatus(interaction, context);
      break;
    case 'codex':
      await handleCodex(interaction, context);
      break;
    case 'chat':
      await handleChat(interaction, context);
      break;
    case 'settings':
      await handleSettings(interaction, context);
      break;
    case 'memory':
      await handleMemory(interaction, context as MemoryCommandContext);
      break;
  }
}

export type { CommandContext } from './types.js';
