/**
 * Select menu handlers for /claude commands
 * - claude_start_dir
 * - claude_stop_session
 * - claude_remove_dir
 * - claude_set_terminal
 */

import { discordLogger as log } from '../../utils/logger.js';
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
  const { processManager } = context;

  if (!processManager) {
    await interaction.reply({ content: '⚠️ Process management not enabled.', ephemeral: true });
    return;
  }

  const sessionId = interaction.values[0];

  try {
    await interaction.update({
      content: `🛑 Stopping session ${sessionId.slice(0, 8)}...`,
      components: [],
    });

    const success = await processManager.kill(sessionId);
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
