/**
 * /memory command handler
 *
 * Subcommands:
 * - opt-out: Disable memory collection for this session (or globally with --global)
 * - opt-in: Enable memory collection for this session (or globally with --global)
 * - status: Show current memory system status
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import type { CommandContext } from './types.js';
import type { BatchDistillRunner } from '../../memory/batch-distill-runner.js';
import type { DailyDigestRunner } from '../../memory/daily-digest.js';
import type { MemoryReporter } from '../memory-reporter.js';
import { updateMemoryConfig, getMemoryConfig } from '../../memory/memory-config.js';

export interface MemoryCommandContext extends CommandContext {
  batchDistillRunner?: BatchDistillRunner;
  dailyDigestRunner?: DailyDigestRunner;
  memoryReporter?: MemoryReporter;
}

export async function handleMemory(
  interaction: ChatInputCommandInteraction,
  context: MemoryCommandContext,
): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const isGlobal = interaction.options.getBoolean('global') ?? false;
  const runner = context.batchDistillRunner;

  switch (sub) {
    case 'opt-out': {
      if (isGlobal) {
        // Global opt-out: disable entire memory system
        await updateMemoryConfig({ distill: { ...getMemoryConfig().distill, enabled: false } });
        if (runner) {
          await runner.setGlobalEnabled(false);
        }
        await interaction.reply('⏸️ Memory system **globally disabled**. Use `/memory opt-in --global` to re-enable.');
        // Notify memory channel
        if (context.memoryReporter) {
          await context.memoryReporter.postNotification('⏸️ **Memory system paused** by user.');
        }
      } else {
        // Thread opt-out
        const threadId = interaction.channelId;
        if (runner) {
          runner.optOutThread(threadId);
        }
        await interaction.reply('🔇 Memory collection **disabled** for this session. Use `/memory opt-in` to re-enable.');
      }
      break;
    }

    case 'opt-in': {
      if (isGlobal) {
        await updateMemoryConfig({ distill: { ...getMemoryConfig().distill, enabled: true } });
        if (runner) {
          await runner.setGlobalEnabled(true);
        }
        await interaction.reply('▶️ Memory system **globally enabled**.');
        if (context.memoryReporter) {
          await context.memoryReporter.postNotification('▶️ **Memory system resumed** by user.');
        }
      } else {
        const threadId = interaction.channelId;
        if (runner) {
          runner.optInThread(threadId);
        }
        await interaction.reply('🔊 Memory collection **enabled** for this session.');
      }
      break;
    }

    case 'status': {
      const config = getMemoryConfig();
      const globalEnabled = runner?.isGlobalEnabled ?? config.distill.enabled;
      const threadId = interaction.channelId;
      const threadOptedOut = runner?.isOptedOut(threadId) ?? false;
      const queueLen = runner?.queueLength ?? 0;

      const lines = [
        `**Memory System Status**`,
        `• Global: ${globalEnabled ? '✅ Enabled' : '⏸️ Disabled'}`,
        `• This session: ${threadOptedOut ? '🔇 Opted out' : '🔊 Active'}`,
        `• Queue: ${queueLen} messages pending`,
        `• Model: \`${config.distill.model}\``,
        `• Batch: max ${config.distill.batchMaxMessages} msgs / ${Math.round(config.distill.batchIntervalMs / 1000)}s interval`,
        `• Session refresh: every ${Math.round(config.distill.sessionRefreshMs / 3600000)}h`,
      ];

      if (config.distill.excludeProjects.length > 0) {
        lines.push(`• Excluded projects: ${config.distill.excludeProjects.join(', ')}`);
      }

      await interaction.reply(lines.join('\n'));
      break;
    }

    case 'digest': {
      if (!context.dailyDigestRunner) {
        await interaction.reply('⚠️ Daily digest is not initialized.');
        return;
      }
      await interaction.deferReply();
      try {
        const digest = await context.dailyDigestRunner.generateDigest();
        if (context.memoryReporter) {
          await context.memoryReporter.postDigest(digest);
        }
        await interaction.editReply(`📬 Digest generated and posted to #sleep-code-memory.\nTasks: ${digest.openTasks} | Decisions: ${digest.recentDecisions} | Topics: ${digest.topTopics.join(', ') || 'none'}`);
      } catch (err) {
        await interaction.editReply(`❌ Digest generation failed: ${(err as Error).message}`);
      }
      break;
    }

    case 'consolidate': {
      if (!runner) {
        await interaction.reply('⚠️ Batch distill runner is not initialized.');
        return;
      }
      await interaction.deferReply();
      try {
        const report = await runner.runConsolidation();
        if (report) {
          await interaction.editReply(`🔄 Consolidation complete. Merged: ${report.totalMerged} | Cleaned: ${report.totalCleaned} | Remaining: ${report.totalRemaining}`);
        } else {
          await interaction.editReply('❌ Consolidation returned no results.');
        }
      } catch (err) {
        await interaction.editReply(`❌ Consolidation failed: ${(err as Error).message}`);
      }
      break;
    }

    default:
      await interaction.reply('Unknown subcommand.');
  }
}
