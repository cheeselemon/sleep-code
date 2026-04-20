/**
 * Select menu handlers for /claude, /codex, /chat commands
 * - claude_start_dir
 * - claude_stop_session
 * - claude_remove_dir
 * - claude_set_terminal
 * - chat_start_model
 * - chat_start_dir:{model}
 */

import { basename } from 'path';
import { randomUUID } from 'crypto';
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import { discordLogger as log } from '../../utils/logger.js';
import { getModelByAlias } from '../agents/model-registry.js';
import type { SelectMenuHandler } from './types.js';

/**
 * Handle directory selection for starting a session
 */
export const handleStartDirSelect: SelectMenuHandler = async (interaction, context) => {
  const { processManager, settingsManager } = context;

  if (!processManager || !settingsManager) {
    await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
    return;
  }

  const cwd = interaction.values[0];

  // Re-validate directory is still in whitelist
  if (!settingsManager.isDirectoryAllowed(cwd)) {
    await interaction.update({
      content: `❌ Directory \`${cwd}\` is no longer in the whitelist.`,
      components: [],
    });
    return;
  }

  // Check maxConcurrentSessions limit
  const maxSessions = settingsManager.getMaxSessions();
  if (maxSessions !== undefined) {
    const running = await processManager.getAllRunning();
    if (running.length >= maxSessions) {
      await interaction.update({
        content: `❌ Maximum concurrent sessions limit reached (${maxSessions}). Stop a session first.`,
        components: [],
      });
      return;
    }
  }

  const sessionId = processManager.generateSessionId();

  try {
    await interaction.update({
      content: `🚀 Starting Claude session in \`${cwd}\`...`,
      components: [],
    });

    const terminalApp = settingsManager.getTerminalApp();
    const entry = await processManager.spawn(cwd, sessionId, terminalApp);
    log.info({ sessionId, cwd, pid: entry.pid, terminalApp }, 'Started Claude session via Discord');

    await interaction.followUp({
      content: `✅ **Session started**\nPID: ${entry.pid}\nSession: ${sessionId.slice(0, 8)}...\nDirectory: \`${cwd}\`\n\nWaiting for connection...`,
      ephemeral: true,
    });
  } catch (err) {
    log.error({ err, cwd }, 'Failed to start session');
    await interaction.followUp({
      content: `❌ Failed to start session: ${(err as Error).message}`,
      ephemeral: true,
    });
  }
};

/**
 * Handle session selection for stopping
 */
export const handleStopSessionSelect: SelectMenuHandler = async (interaction, context) => {
  const { processManager, claudeSdkSessionManager } = context;

  const value = interaction.values[0];
  // Value format: "type:sessionId" (sdk:xxx or pty:xxx) or legacy "sessionId"
  let sessionType: 'pty' | 'sdk' = 'pty';
  let sessionId = value;

  if (value.startsWith('sdk:')) {
    sessionType = 'sdk';
    sessionId = value.slice(4);
  } else if (value.startsWith('pty:')) {
    sessionId = value.slice(4);
  }

  try {
    await interaction.update({
      content: `🛑 Stopping ${sessionType.toUpperCase()} session ${sessionId.slice(0, 8)}...`,
      components: [],
    });

    let success = false;
    if (sessionType === 'sdk' && claudeSdkSessionManager) {
      success = await claudeSdkSessionManager.stopSession(sessionId);
    } else if (processManager) {
      success = await processManager.kill(sessionId);
    }

    if (success) {
      await interaction.followUp({
        content: `✅ Session ${sessionId.slice(0, 8)} stopped.`,
        ephemeral: true,
      });
    } else {
      await interaction.followUp({
        content: `❌ Failed to stop session.`,
        ephemeral: true,
      });
    }
  } catch (err) {
    log.error({ err, sessionId }, 'Failed to stop session');
    await interaction.followUp({
      content: `❌ Error: ${(err as Error).message}`,
      ephemeral: true,
    });
  }
};

/**
 * Handle directory selection for removal
 */
export const handleRemoveDirSelect: SelectMenuHandler = async (interaction, context) => {
  const { settingsManager } = context;

  if (!settingsManager) {
    await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
    return;
  }

  const dir = interaction.values[0];
  const success = await settingsManager.removeDirectory(dir);

  await interaction.update({
    content: success
      ? `✅ Removed \`${dir}\` from whitelist.`
      : `❌ Failed to remove directory.`,
    components: [],
  });
};

/**
 * Handle terminal app selection
 */
export const handleSetTerminalSelect: SelectMenuHandler = async (interaction, context) => {
  const { settingsManager } = context;

  if (!settingsManager) {
    await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
    return;
  }

  const app = interaction.values[0] as 'terminal' | 'iterm2' | 'background';
  await settingsManager.setTerminalApp(app);

  const appNames: Record<string, string> = {
    terminal: 'Terminal.app',
    iterm2: 'iTerm2',
    background: 'Background (no window)',
  };

  // Add permission notice for terminal apps
  const permissionNotice = app !== 'background'
    ? `\n\n⚠️ **macOS will request permission on first run.**\nClick "Allow" to let AppleScript control ${appNames[app]}.`
    : '';

  await interaction.update({
    content: `✅ Terminal app set to **${appNames[app]}**\n\nNew sessions will open in ${app === 'background' ? 'the background' : 'a new terminal window'}.${permissionNotice}`,
    components: [],
  });
};

/**
 * Handle directory selection for starting a Codex session
 */
export const handleCodexStartDirSelect: SelectMenuHandler = async (interaction, context) => {
  const { codexSessionManager, channelManager, settingsManager, state } = context;

  if (!codexSessionManager || !settingsManager) {
    await interaction.reply({ content: '⚠️ Codex is not enabled.', ephemeral: true });
    return;
  }

  const cwd = interaction.values[0];

  if (!settingsManager.isDirectoryAllowed(cwd)) {
    await interaction.update({
      content: `❌ Directory \`${cwd}\` is no longer in the whitelist.`,
      components: [],
    });
    return;
  }

  try {
    await interaction.update({
      content: `🚀 Starting Codex session in \`${cwd}\`...`,
      components: [],
    });

    // Create thread first, then start Codex session
    const sessionName = `codex-${basename(cwd)}`;
    const mapping = await channelManager.createCodexSession('pending', sessionName, cwd);
    if (!mapping) {
      await interaction.followUp({ content: '❌ Failed to create thread.', ephemeral: true });
      return;
    }

    // Check if the thread's Claude session has YOLO enabled
    const claudeSessionId = channelManager.getSessionByChannel(interaction.channelId);
    const isYolo = claudeSessionId ? state.yoloSessions.has(claudeSessionId) : false;

    const entry = await codexSessionManager.startSession(cwd, mapping.threadId, {
      sandboxMode: isYolo ? 'workspace-write' : 'read-only',
    });

    // Update channel manager with real session ID
    channelManager.updateCodexSessionId('pending', entry.id);

    await interaction.followUp({
      content: `✅ **Codex session started**\nSession: ${entry.id.slice(0, 8)}...\nDirectory: \`${cwd}\``,
      ephemeral: true,
    });
  } catch (err) {
    log.error({ err, cwd }, 'Failed to start Codex session');
    await interaction.followUp({
      content: `❌ Failed to start Codex session: ${(err as Error).message}`,
      ephemeral: true,
    });
  }
};

/**
 * Handle session selection for stopping a Codex session
 */
export const handleCodexStopSessionSelect: SelectMenuHandler = async (interaction, context) => {
  const { codexSessionManager, channelManager } = context;

  if (!codexSessionManager) {
    await interaction.reply({ content: '⚠️ Codex is not enabled.', ephemeral: true });
    return;
  }

  const sessionId = interaction.values[0];

  try {
    await interaction.update({
      content: `🛑 Stopping Codex session ${sessionId.slice(0, 8)}...`,
      components: [],
    });

    const success = await codexSessionManager.stopSession(sessionId);
    if (success) {
      await channelManager.archiveCodexSession(sessionId);
      await interaction.followUp({
        content: `✅ Codex session ${sessionId.slice(0, 8)} stopped.`,
        ephemeral: true,
      });
    } else {
      await interaction.followUp({
        content: '❌ Failed to stop Codex session.',
        ephemeral: true,
      });
    }
  } catch (err) {
    log.error({ err, sessionId }, 'Failed to stop Codex session');
    await interaction.followUp({
      content: `❌ Error: ${(err as Error).message}`,
      ephemeral: true,
    });
  }
};

/** SDK model display names */
const SDK_MODEL_DISPLAY: Record<string, string> = {
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5': 'Haiku 4.5',
};

/**
 * Handle model+context selection for starting a Claude SDK session
 * Shows directory picker after selection
 * value format: "claude-opus-4-7:200k" or "claude-sonnet-4-6:1m"
 */
export const handleSdkStartConfigSelect: SelectMenuHandler = async (interaction, context) => {
  const { settingsManager } = context;

  if (!settingsManager) {
    await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
    return;
  }

  const raw = interaction.values[0];
  // Split on last colon to separate model ID from context size
  const lastColon = raw.lastIndexOf(':');
  const modelId = raw.slice(0, lastColon);
  const contextSize = raw.slice(lastColon + 1);

  if (!SDK_MODEL_DISPLAY[modelId]) {
    await interaction.update({ content: `❌ Unknown model: ${modelId}`, components: [] });
    return;
  }

  const dirs = settingsManager.getAllowedDirectories();
  if (dirs.length === 0) {
    await interaction.update({
      content: '⚠️ No directories configured. Use `/claude add-dir` first.',
      components: [],
    });
    return;
  }

  // Embed model + context in customId for next step
  // Use | as separator since model IDs contain colons... actually they don't, they use hyphens
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`claude_sdk_start_dir:${modelId}:${contextSize}`)
    .setPlaceholder('Select a directory...');

  for (const dir of dirs.slice(0, 25)) {
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(basename(dir))
        .setDescription(dir.slice(0, 100))
        .setValue(dir)
    );
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  const ctxLabel = contextSize === '1m' ? '1M' : '200K';

  await interaction.update({
    content: `📡 **Start Claude SDK Session** — ${SDK_MODEL_DISPLAY[modelId]} (${ctxLabel})\nSelect a directory:`,
    components: [row],
  });
};

/**
 * Handle directory selection for starting a Claude SDK session
 * customId format: claude_sdk_start_dir:{modelId}:{context}
 * e.g. claude_sdk_start_dir:claude-opus-4-7:1m
 */
export const handleSdkStartDirSelect: SelectMenuHandler = async (interaction, context) => {
  const { claudeSdkSessionManager, channelManager, settingsManager } = context;

  if (!claudeSdkSessionManager || !settingsManager) {
    await interaction.reply({ content: '⚠️ Claude SDK is not enabled.', ephemeral: true });
    return;
  }

  // customId: "claude_sdk_start_dir:claude-opus-4-7:1m"
  // Split: ["claude_sdk_start_dir", "claude-opus-4-7", "1m"]
  // But model IDs contain hyphens, so use known prefix + last segment
  const withoutPrefix = interaction.customId.slice('claude_sdk_start_dir:'.length); // "claude-opus-4-7:1m"
  const lastColon = withoutPrefix.lastIndexOf(':');
  const modelId = lastColon > 0 ? withoutPrefix.slice(0, lastColon) : 'claude-opus-4-7';
  const contextSize = lastColon > 0 ? withoutPrefix.slice(lastColon + 1) : '200k';
  const betas: string[] = contextSize === '1m' ? ['context-1m-2025-08-07'] : [];
  const displayName = SDK_MODEL_DISPLAY[modelId] || modelId;

  const cwd = interaction.values[0];

  if (!settingsManager.isDirectoryAllowed(cwd)) {
    await interaction.update({
      content: `❌ Directory \`${cwd}\` is no longer in the whitelist.`,
      components: [],
    });
    return;
  }

  const ctxLabel = contextSize === '1m' ? '1M' : '200K';

  try {
    await interaction.update({
      content: `📡 Starting Claude SDK session in \`${cwd}\` — ${displayName} (${ctxLabel})...`,
      components: [],
    });

    const sessionId = randomUUID();
    const sessionName = `claude-sdk-${basename(cwd)}`;
    const mapping = await channelManager.createSdkSession(sessionId, sessionName, cwd);
    if (!mapping) {
      await interaction.followUp({ content: '❌ Failed to create SDK thread.', ephemeral: true });
      return;
    }

    const entry = await claudeSdkSessionManager.startSession(cwd, mapping.threadId, { sessionId, model: modelId, betas });
    channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);

    await interaction.followUp({
      content: `✅ **Claude SDK session started**\nModel: **${displayName}** (${ctxLabel})\nSession: ${entry.id.slice(0, 8)}...\nDirectory: \`${cwd}\``,
      ephemeral: true,
    });
  } catch (err) {
    log.error({ err, cwd }, 'Failed to start Claude SDK session');
    await interaction.followUp({
      content: `❌ Failed to start Claude SDK session: ${(err as Error).message}`,
      ephemeral: true,
    });
  }
};

// ── Agent (OpenRouter/DeepInfra) select menu handlers ─────────────

/**
 * Handle model selection for /chat start — then show directory picker
 */
export const handleAgentStartModelSelect: SelectMenuHandler = async (interaction, context) => {
  const { settingsManager } = context;

  if (!settingsManager) {
    await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
    return;
  }

  const modelAlias = interaction.values[0];
  const modelDef = getModelByAlias(modelAlias);
  if (!modelDef) {
    await interaction.update({ content: `❌ Unknown model: ${modelAlias}`, components: [] });
    return;
  }

  const dirs = settingsManager.getAllowedDirectories();
  if (dirs.length === 0) {
    await interaction.update({
      content: '⚠️ No directories configured. Use `/claude add-dir` first.',
      components: [],
    });
    return;
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`chat_start_dir:${modelAlias}`)
    .setPlaceholder('Select a directory...');

  for (const dir of dirs.slice(0, 25)) {
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(basename(dir))
        .setDescription(dir.slice(0, 100))
        .setValue(dir)
    );
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

  await interaction.update({
    content: `🤖 **Start ${modelDef.displayName} Session**\nSelect a directory:`,
    components: [row],
  });
};

/**
 * Handle directory selection for /chat start — actually start the agent session
 */
export const handleAgentStartDirSelect: SelectMenuHandler = async (interaction, context) => {
  const { agentSessionManager, channelManager, settingsManager } = context;

  if (!agentSessionManager || !settingsManager) {
    await interaction.reply({ content: '⚠️ Agent system is not enabled.', ephemeral: true });
    return;
  }

  // customId format: chat_start_dir:{modelAlias}
  const modelAlias = interaction.customId.split(':')[1];
  const cwd = interaction.values[0];

  if (!settingsManager.isDirectoryAllowed(cwd)) {
    await interaction.update({
      content: `❌ Directory \`${cwd}\` is no longer in the whitelist.`,
      components: [],
    });
    return;
  }

  const modelDef = getModelByAlias(modelAlias);
  if (!modelDef) {
    await interaction.update({ content: `❌ Unknown model: ${modelAlias}`, components: [] });
    return;
  }

  try {
    await interaction.update({
      content: `🚀 Starting ${modelDef.displayName} session in \`${cwd}\`...`,
      components: [],
    });

    // Create thread via channelManager (dedicated agent store — NOT sdkStore)
    const sessionId = randomUUID();
    const sessionName = `${modelAlias}-${basename(cwd)}`;
    const mapping = await channelManager.createAgentSession(sessionId, sessionName, cwd, modelAlias, modelDef.displayName);
    if (!mapping) {
      await interaction.followUp({ content: '❌ Failed to create thread.', ephemeral: true });
      return;
    }

    let entry;
    try {
      entry = await agentSessionManager.startSession(modelAlias, cwd, mapping.threadId, { sessionId });
    } catch (startErr) {
      // startSession 실패 시 orphan mapping 정리
      await channelManager.archiveAgentSession(sessionId);
      throw startErr;
    }

    await interaction.followUp({
      content: `✅ **${modelDef.displayName} session started**\nSession: ${entry.id.slice(0, 8)}...\nDirectory: \`${cwd}\``,
      ephemeral: true,
    });
  } catch (err) {
    log.error({ err, cwd, modelAlias }, 'Failed to start agent session');
    await interaction.followUp({
      content: `❌ Failed to start agent session: ${(err as Error).message}`,
      ephemeral: true,
    });
  }
};
