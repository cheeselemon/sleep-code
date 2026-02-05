/**
 * Tool call/result handlers
 * - onToolCall
 * - onToolResult
 * - onPlanModeChange
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  AttachmentBuilder,
} from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import { getThread } from '../utils.js';
import { SKIP_RESULT_TOOLS } from '../state.js';
import type { HandlerContext } from './types.js';

export function createToolCallHandler(context: HandlerContext) {
  const { client, channelManager, state } = context;

  return async (sessionId: string, tool: { id: string; name: string; input: any }) => {
    log.info({ tool: tool.name, id: tool.id, inputPreview: JSON.stringify(tool.input).slice(0, 200) }, 'onToolCall');

    const thread = await getThread(client, channelManager, sessionId);
    if (!thread) {
      log.debug({ sessionId }, 'No thread for session');
      return;
    }

    // Special handling for AskUserQuestion
    if (tool.name === 'AskUserQuestion' && tool.input.questions) {
      log.info({ count: tool.input.questions.length }, 'AskUserQuestion detected');
      try {
        // Store pending question for interaction handling
        state.pendingQuestions.set(tool.id, {
          sessionId,
          toolUseId: tool.id,
          questions: tool.input.questions,
        });

        // Build message with buttons/select menu for each question
        for (let qIdx = 0; qIdx < tool.input.questions.length; qIdx++) {
          const q = tool.input.questions[qIdx];
          const questionText = `❓ **${q.header}**\n${q.question}`;

          if (q.multiSelect) {
            // Use StringSelectMenu for multiSelect questions
            const selectMenu = new StringSelectMenuBuilder()
              .setCustomId(`askq_select:${tool.id}:${qIdx}`)
              .setPlaceholder('Select options...')
              .setMinValues(1)
              .setMaxValues(q.options.length);

            for (let oIdx = 0; oIdx < q.options.length; oIdx++) {
              const opt = q.options[oIdx];
              selectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                  .setLabel(opt.label.slice(0, 100))
                  .setDescription(opt.description.slice(0, 100))
                  .setValue(`${oIdx}`)
              );
            }

            const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

            // Add Submit and Other buttons in a separate row
            const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`askq_submit:${tool.id}:${qIdx}`)
                .setLabel('Submit')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`askq:${tool.id}:${qIdx}:other`)
                .setLabel('Other...')
                .setStyle(ButtonStyle.Secondary)
            );

            await thread.send({
              content: questionText,
              components: [selectRow, buttonRow],
            });
          } else {
            // Use buttons for single-select questions (max 5 per row, max 4 options + Other)
            // Build option list with descriptions since buttons don't support descriptions
            const optionsList = q.options
              .map((opt: { label: string; description: string }, idx: number) =>
                `${idx + 1}. **${opt.label}** - ${opt.description}`)
              .join('\n');
            const questionTextWithOptions = `${questionText}\n\n${optionsList}`;

            const rows: ActionRowBuilder<ButtonBuilder>[] = [];
            const currentRow = new ActionRowBuilder<ButtonBuilder>();

            for (let oIdx = 0; oIdx < q.options.length && oIdx < 4; oIdx++) {
              const opt = q.options[oIdx];
              const button = new ButtonBuilder()
                .setCustomId(`askq:${tool.id}:${qIdx}:${oIdx}`)
                .setLabel(opt.label.slice(0, 80))
                .setStyle(ButtonStyle.Primary);

              currentRow.addComponents(button);
            }

            // Add "Other" button
            const otherButton = new ButtonBuilder()
              .setCustomId(`askq:${tool.id}:${qIdx}:other`)
              .setLabel('Other...')
              .setStyle(ButtonStyle.Secondary);
            currentRow.addComponents(otherButton);

            rows.push(currentRow);

            await thread.send({
              content: questionTextWithOptions,
              components: rows,
            });
          }
        }
      } catch (err) {
        log.error({ err }, 'Failed to post AskUserQuestion');
      }
      return;
    }

    // Format tool call summary
    let inputSummary = '';
    if (tool.name === 'Bash' && tool.input.command) {
      inputSummary = `\`${tool.input.command.slice(0, 100)}${tool.input.command.length > 100 ? '...' : ''}\``;
    } else if (tool.name === 'Read' && tool.input.file_path) {
      inputSummary = `\`${tool.input.file_path}\``;
    } else if (tool.name === 'Edit' && tool.input.file_path) {
      inputSummary = `\`${tool.input.file_path}\``;
    } else if (tool.name === 'Write' && tool.input.file_path) {
      inputSummary = `\`${tool.input.file_path}\``;
    } else if (tool.name === 'Grep' && tool.input.pattern) {
      inputSummary = `\`${tool.input.pattern}\``;
    } else if (tool.name === 'Glob' && tool.input.pattern) {
      inputSummary = `\`${tool.input.pattern}\``;
    } else if (tool.name === 'Task' && tool.input.description) {
      inputSummary = tool.input.description;
    }

    const text = inputSummary
      ? `🔧 **${tool.name}**: ${inputSummary}`
      : `🔧 **${tool.name}**`;

    try {
      const message = await thread.send(text);
      // Store the message id, tool name, and file path for Write tools
      const filePath = (tool.name === 'Write' || tool.name === 'Edit') ? tool.input.file_path : undefined;
      state.toolCallMessages.set(tool.id, { messageId: message.id, toolName: tool.name, filePath });
    } catch (err) {
      log.error({ err }, 'Failed to post tool call');
    }
  };
}

export function createToolResultHandler(context: HandlerContext) {
  const { client, channelManager, state } = context;

  return async (sessionId: string, result: { toolUseId: string; content: string; isError: boolean }) => {
    const toolInfo = state.toolCallMessages.get(result.toolUseId);
    state.toolCallMessages.delete(result.toolUseId);

    // Skip verbose tool results
    if (toolInfo && SKIP_RESULT_TOOLS.has(toolInfo.toolName)) {
      return;
    }

    const thread = await getThread(client, channelManager, sessionId);
    if (!thread) return;

    // Upload file for Write/Edit tools on success
    if (toolInfo?.filePath && !result.isError && (toolInfo.toolName === 'Write' || toolInfo.toolName === 'Edit')) {
      try {
        const attachment = new AttachmentBuilder(toolInfo.filePath);
        await thread.send({
          content: `📄 **File ${toolInfo.toolName === 'Write' ? 'created' : 'edited'}**`,
          files: [attachment],
        });
        log.info({ filePath: toolInfo.filePath }, 'Uploaded file');
      } catch (err) {
        log.error({ err }, 'Failed to upload file');
      }
      return; // Skip text result for file operations
    }

    // Truncate long results
    const maxLen = 300;
    const fullContent = result.content;
    const isTruncated = fullContent.length > maxLen;
    let content = fullContent;
    if (isTruncated) {
      content = fullContent.slice(0, maxLen) + '\n... (truncated)';
    }

    const prefix = result.isError ? '❌ Error:' : '✅ Result:';
    const text = `${prefix}\n\`\`\`\n${content}\n\`\`\``;

    // Create "View Full" button if truncated
    let components: ActionRowBuilder<ButtonBuilder>[] = [];
    if (isTruncated) {
      const resultId = `${result.toolUseId}-${Date.now()}`;
      state.pendingFullResults.set(resultId, {
        content: fullContent,
        toolName: toolInfo?.toolName || 'unknown',
        createdAt: Date.now(),
      });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`fullresult:${resultId}`)
          .setLabel('View Full')
          .setStyle(ButtonStyle.Secondary)
      );
      components = [row];
    }

    try {
      if (toolInfo?.messageId) {
        // Reply to the tool call message
        const parentMessage = await thread.messages.fetch(toolInfo.messageId);
        if (parentMessage) {
          await parentMessage.reply({ content: text, components });
        } else {
          await thread.send({ content: text, components });
        }
      } else {
        await thread.send({ content: text, components });
      }
    } catch (err) {
      log.error({ err }, 'Failed to post tool result');
    }
  };
}

export function createPlanModeChangeHandler(context: HandlerContext) {
  const { client, channelManager } = context;

  return async (sessionId: string, inPlanMode: boolean) => {
    const thread = await getThread(client, channelManager, sessionId);
    if (!thread) return;

    const emoji = inPlanMode ? '📋' : '🔨';
    const status = inPlanMode ? 'Planning mode - Claude is designing a solution' : 'Execution mode - Claude is implementing';

    try {
      await thread.send(`${emoji} ${status}`);
    } catch (err) {
      log.error({ err }, 'Failed to post plan mode change');
    }
  };
}
