/**
 * /help command handler
 */

import { EmbedBuilder } from 'discord.js';
import type { CommandHandler } from './types.js';

export const handleHelp: CommandHandler = async (interaction) => {
  const embed = new EmbedBuilder()
    .setTitle('🤖 Sleep Code Commands')
    .setDescription('Monitor and control AI agent sessions from Discord')
    .setColor(0x7289DA)
    .addFields(
      {
        name: '🟣 Claude Sessions',
        value: [
          '`/claude start` - Start a PTY session (terminal)',
          '`/claude start-sdk` - Start an SDK session (lightweight)',
          '`/claude stop` - Stop a running session',
          '`/claude restore` - Restore a dead session in this thread',
          '`/claude status` - Show all managed sessions',
          '`/sessions` - List all active sessions',
          '`/status` - Show current thread session status',
        ].join('\n'),
      },
      {
        name: '🟢 Codex (OpenAI)',
        value: [
          '`/codex start` - Start a Codex session',
          '`/codex stop` - Stop a running Codex session',
          '`/codex status` - Show all Codex sessions',
        ].join('\n'),
      },
      {
        name: '🤖 Generic Agents (OpenRouter)',
        value: [
          '`/chat start` - Start an agent session (select model)',
          '`/chat stop` - Stop agent in current thread',
          '`/chat status` - Show active agent sessions',
          '`/chat models` - Show available models & pricing',
          '',
          '**Models:**',
          '💎 `gemma4` - Gemma 4 31B (262K ctx, $0.13/$0.38)',
          '🧊 `glm5` - GLM-5 (80K ctx, $0.72/$2.30)',
          '🧊 `glm51` - GLM-5.1 (202K ctx, $0.95/$3.15)',
          '🌀 `qwen3-coder` - Qwen3 Coder (262K ctx, $0.22/$1.00)',
        ].join('\n'),
      },
      {
        name: '🎮 In-Session Controls',
        value: [
          '`/interrupt` - Interrupt current turn',
          '`/yolo-sleep` - Toggle auto-approve mode',
          '`/panel` - Show control panel with buttons',
          '`/model <name>` - Switch model (opus/sonnet/haiku)',
          '`/compact` - Compact conversation (PTY only)',
          '`/background` - Send to background (PTY only)',
          '`/mode` - Toggle plan/execute mode (PTY only)',
          '`!잠깐` - Text-based interrupt',
        ].join('\n'),
      },
      {
        name: '💬 Multi-Agent Routing',
        value: [
          '`@claude` / `@codex` / `@gemma4` / `@glm5` / `@glm51` / `@qwen3-coder`',
          'Mention an agent to route your message or auto-create a session.',
          'Agents can also route to each other via @mentions.',
        ].join('\n'),
      },
      {
        name: '⚙️ Settings',
        value: [
          '`/claude add-dir <path>` - Add directory to whitelist',
          '`/claude remove-dir` - Remove from whitelist',
          '`/claude list-dirs` - List whitelisted directories',
          '`/claude set-terminal` - Set terminal app',
          '`/settings` - Show bot & memory config',
          '`/commands` - List all slash commands',
        ].join('\n'),
      },
      {
        name: '🧠 Memory',
        value: [
          '`/memory opt-in` / `opt-out` - Toggle memory collection',
          '`/memory status` - Show memory stats',
          '`/memory digest` - Trigger daily digest now',
          '`/memory consolidate` - Run memory consolidation',
        ].join('\n'),
      },
      {
        name: '💡 Tips',
        value: [
          'SDK & agent sessions auto-resume after bot restart',
          'Context usage shown after each turn (🟢🟡🔴)',
          'Attach `.txt` files to inject content into session',
          'Set `OPENROUTER_API_KEY` in `~/.sleep-code/discord.env` for agents',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'Sleep Code — Code from your bed' });

  await interaction.reply({ embeds: [embed], ephemeral: true });
};
