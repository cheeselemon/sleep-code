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
import { SDK_MODEL_DISPLAY } from '../claude-sdk/models.js';
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
 * Codex reasoning effort type — duplicated from codex-session-manager to avoid
 * importing the runtime module here.
 */
type CodexEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Validate a model+effort string against the known set so an attacker can't
 * inject arbitrary values via crafted Discord interactions. Loose allowlist:
 * any of the model slugs from ~/.codex/models_cache.json + standard efforts.
 */
const CODEX_VALID_MODELS = new Set([
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2',
]);
const CODEX_VALID_EFFORTS: ReadonlySet<CodexEffort> = new Set([
  'minimal', 'low', 'medium', 'high', 'xhigh',
]);

function parseCodexConfig(value: string): { model: string; effort: CodexEffort } | null {
  const [model, effortStr] = value.split(':');
  if (!model || !effortStr) return null;
  if (!CODEX_VALID_MODELS.has(model)) return null;
  if (!CODEX_VALID_EFFORTS.has(effortStr as CodexEffort)) return null;
  return { model, effort: effortStr as CodexEffort };
}

function codexConfigDisplay(model: string, effort: string): string {
  // Convert `gpt-5.5` → `GPT-5.5`, `gpt-5.4-mini` → `GPT-5.4-mini`
  const display = model.replace(/^gpt-/, 'GPT-');
  return `${display} (${effort})`;
}

/**
 * Step 1: User picks a Codex model + reasoning effort. We then show the
 * directory picker, encoding the selection in the next customId.
 */
export const handleCodexStartConfigSelect: SelectMenuHandler = async (interaction, context) => {
  const { settingsManager } = context;

  if (!settingsManager) {
    await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
    return;
  }

  const parsed = parseCodexConfig(interaction.values[0]);
  if (!parsed) {
    await interaction.update({
      content: `❌ Invalid model selection: ${interaction.values[0]}`,
      components: [],
    });
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
    .setCustomId(`codex_start_dir:${parsed.model}:${parsed.effort}`)
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
    content: `🤖 **Start Codex Session** — ${codexConfigDisplay(parsed.model, parsed.effort)}\nSelect a directory:`,
    components: [row],
  });
};

/**
 * Step 2: User picks a directory. Start the Codex session with the model +
 * effort encoded in the customId.
 *
 * customId format: `codex_start_dir` (legacy, no model) OR
 *                  `codex_start_dir:<model>:<effort>` (with selection).
 * Legacy form falls back to CODEX_MODEL + CODEX_DEFAULT_REASONING in
 * codexSessionManager.startSession.
 */
export const handleCodexStartDirSelect: SelectMenuHandler = async (interaction, context) => {
  const { codexSessionManager, channelManager, settingsManager, state } = context;

  if (!codexSessionManager || !settingsManager) {
    await interaction.reply({ content: '⚠️ Codex is not enabled.', ephemeral: true });
    return;
  }

  const cwd = interaction.values[0];

  // Decode model + effort from customId (set by handleCodexStartConfigSelect).
  // Format: `codex_start_dir:<model>:<effort>` — bare prefix means defaults.
  let model: string | undefined;
  let modelReasoningEffort: CodexEffort | undefined;
  if (interaction.customId.startsWith('codex_start_dir:')) {
    const rest = interaction.customId.slice('codex_start_dir:'.length);
    const parsed = parseCodexConfig(rest);
    if (parsed) {
      model = parsed.model;
      modelReasoningEffort = parsed.effort;
    }
  }

  if (!settingsManager.isDirectoryAllowed(cwd)) {
    await interaction.update({
      content: `❌ Directory \`${cwd}\` is no longer in the whitelist.`,
      components: [],
    });
    return;
  }

  try {
    const displayName = model && modelReasoningEffort
      ? codexConfigDisplay(model, modelReasoningEffort)
      : 'default model';
    await interaction.update({
      content: `🚀 Starting Codex session in \`${cwd}\` — ${displayName}...`,
      components: [],
    });

    // Create thread first, then start Codex session
    const sessionName = `codex-${basename(cwd)}`;
    const mapping = await channelManager.createCodexSession(
      'pending', sessionName, cwd, undefined, model, modelReasoningEffort,
    );
    if (!mapping) {
      await interaction.followUp({ content: '❌ Failed to create thread.', ephemeral: true });
      return;
    }

    // Check if the thread's Claude session has YOLO enabled
    const claudeSessionId = channelManager.getSessionByChannel(interaction.channelId);
    const isYolo = claudeSessionId ? state.yoloSessions.has(claudeSessionId) : false;

    const entry = await codexSessionManager.startSession(cwd, mapping.threadId, {
      sandboxMode: isYolo ? 'workspace-write' : 'read-only',
      model,
      modelReasoningEffort,
    });

    // Update channel manager with real session ID
    channelManager.updateCodexSessionId('pending', entry.id);

    await interaction.followUp({
      content: `✅ **Codex session started**\nModel: **${codexConfigDisplay(entry.model, entry.modelReasoningEffort)}**\nSession: ${entry.id.slice(0, 8)}...\nDirectory: \`${cwd}\``,
      ephemeral: true,
    });
  } catch (err) {
    log.error({ err, cwd, model, modelReasoningEffort }, 'Failed to start Codex session');
    await interaction.followUp({
      content: `❌ Failed to start Codex session: ${(err as Error).message}`,
      ephemeral: true,
    });
  }
};

/**
 * Handle reasoning effort change for a running Codex session.
 * customId format: `codex_intelligence:<sessionId>`
 */
export const handleCodexIntelligenceSelect: SelectMenuHandler = async (interaction, context) => {
  const { codexSessionManager, channelManager } = context;

  if (!codexSessionManager) {
    await interaction.reply({ content: '⚠️ Codex is not enabled.', ephemeral: true });
    return;
  }

  // Decode sessionId from customId
  const sessionId = interaction.customId.slice('codex_intelligence:'.length);
  if (!sessionId) {
    await interaction.update({ content: '❌ Invalid session ID.', components: [] });
    return;
  }

  const newEffort = interaction.values[0];
  if (!CODEX_VALID_EFFORTS.has(newEffort as CodexEffort)) {
    await interaction.update({
      content: `❌ Invalid reasoning effort: ${newEffort}`,
      components: [],
    });
    return;
  }

  const session = codexSessionManager.getSession(sessionId);
  if (!session) {
    await interaction.update({
      content: '❌ Codex session no longer exists (may have ended).',
      components: [],
    });
    return;
  }

  if (session.modelReasoningEffort === newEffort) {
    await interaction.update({
      content: `ℹ️ Already using **${newEffort}** — no change.`,
      components: [],
    });
    return;
  }

  const oldEffort = session.modelReasoningEffort;

  try {
    await interaction.update({
      content: `🧠 Switching reasoning effort: **${oldEffort}** → **${newEffort}**...`,
      components: [],
    });

    const ok = await codexSessionManager.switchReasoningEffort(sessionId, newEffort as CodexEffort);
    if (!ok) {
      await interaction.followUp({
        content: '❌ Failed to switch reasoning effort.',
        ephemeral: true,
      });
      return;
    }

    // Persist so the change survives bot/PM2 restart
    channelManager.setCodexReasoningEffort(sessionId, newEffort as CodexEffort);

    await interaction.followUp({
      content: `✅ **Codex reasoning effort changed**\n\`${session.model}\` · ${oldEffort} → **${newEffort}**\n\nNext message will use the new level.`,
      ephemeral: true,
    });
  } catch (err) {
    log.error({ err, sessionId, newEffort }, 'Failed to switch Codex reasoning effort');
    await interaction.followUp({
      content: `❌ Error: ${(err as Error).message}`,
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

/**
 * SDK model display labels. Keys use Claude Code's model identifier format:
 *   `<model-id>` → 200K context
 *   `<model-id>[1m]` → 1M context variant
 */
/**
 * customId encoding: `sonnet[1m]` contains brackets which Discord allows
 * but colons are our delimiter, so we base64-encode model IDs for safety.
 */
function encodeModelId(model: string): string {
  return Buffer.from(model, 'utf8').toString('base64url');
}
function decodeModelId(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

/**
 * Step 1: User picks a model variant. We then show the directory picker.
 */
export const handleSdkStartConfigSelect: SelectMenuHandler = async (interaction, context) => {
  const { settingsManager } = context;

  if (!settingsManager) {
    await interaction.reply({ content: '⚠️ Settings management not enabled.', ephemeral: true });
    return;
  }

  const modelId = interaction.values[0];
  const displayName = SDK_MODEL_DISPLAY[modelId];

  if (!displayName) {
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

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`claude_sdk_start_dir:${encodeModelId(modelId)}`)
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
    content: `📡 **Start Claude SDK Session** — ${displayName}\nSelect a directory:`,
    components: [row],
  });
};

/**
 * Step 2: User picks a directory. Start the session with the selected model.
 * customId format: `claude_sdk_start_dir:<base64url(modelId)>`
 */
export const handleSdkStartDirSelect: SelectMenuHandler = async (interaction, context) => {
  const { claudeSdkSessionManager, channelManager, settingsManager } = context;

  if (!claudeSdkSessionManager || !settingsManager) {
    await interaction.reply({ content: '⚠️ Claude SDK is not enabled.', ephemeral: true });
    return;
  }

  const encoded = interaction.customId.slice('claude_sdk_start_dir:'.length);
  const modelId = encoded ? decodeModelId(encoded) : 'claude-opus-4-7[1m]';
  const displayName = SDK_MODEL_DISPLAY[modelId] || modelId;

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
      content: `📡 Starting Claude SDK session in \`${cwd}\` — ${displayName}...`,
      components: [],
    });

    const sessionId = randomUUID();
    const sessionName = `claude-sdk-${basename(cwd)}`;
    const mapping = await channelManager.createSdkSession(sessionId, sessionName, cwd, undefined, undefined, modelId);
    if (!mapping) {
      await interaction.followUp({ content: '❌ Failed to create SDK thread.', ephemeral: true });
      return;
    }

    const entry = await claudeSdkSessionManager.startSession(cwd, mapping.threadId, { sessionId, model: modelId });
    channelManager.setSdkSessionId(entry.id, entry.sdkSessionId);

    await interaction.followUp({
      content: `✅ **Claude SDK session started**\nModel: **${displayName}**\nSession: ${entry.id.slice(0, 8)}...\nDirectory: \`${cwd}\``,
      ephemeral: true,
    });
  } catch (err) {
    log.error({ err, cwd, modelId }, 'Failed to start Claude SDK session');
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
