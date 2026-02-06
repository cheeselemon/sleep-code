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
import type { CommandContext } from './types.js';

/**
 * All slash command definitions
 */
export const commands = [
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
        .setDescription('Set terminal app for new sessions')),
];

/**
 * Handle slash command interactions
 */
export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  context: CommandContext
): Promise<void> {
  const { commandName } = interaction;

  switch (commandName) {
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
  }
}

export type { CommandContext } from './types.js';
