import { readFile, writeFile, mkdir, access, stat } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { discordLogger as log } from '../utils/logger.js';

const CONFIG_DIR = join(homedir(), '.sleep-code');
const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');

export type TerminalApp = 'terminal' | 'iterm2' | 'background';

export interface SleepCodeSettings {
  version: 1;
  allowedDirectories: string[];
  defaultDirectory?: string;
  autoCleanupOrphans: boolean;
  maxConcurrentSessions?: number;
  terminalApp?: TerminalApp;
}

export class SettingsManager {
  private settings: SleepCodeSettings = {
    version: 1,
    allowedDirectories: [],
    autoCleanupOrphans: true,
  };

  async initialize(): Promise<void> {
    await this.loadSettings();
  }

  /**
   * Get all allowed directories
   */
  getAllowedDirectories(): string[] {
    return [...this.settings.allowedDirectories];
  }

  /**
   * Add a directory to the whitelist
   * Returns false if already exists or invalid path
   */
  async addDirectory(path: string): Promise<{ success: boolean; error?: string }> {
    const resolved = resolve(path);

    // Check if path exists and is a directory
    try {
      const stats = await stat(resolved);
      if (!stats.isDirectory()) {
        return { success: false, error: 'Path is not a directory' };
      }
    } catch {
      return { success: false, error: 'Directory does not exist' };
    }

    // Check if already in list
    if (this.settings.allowedDirectories.includes(resolved)) {
      return { success: false, error: 'Directory already in whitelist' };
    }

    this.settings.allowedDirectories.push(resolved);
    await this.saveSettings();

    log.info({ path: resolved }, 'Added directory to whitelist');
    return { success: true };
  }

  /**
   * Remove a directory from the whitelist
   */
  async removeDirectory(path: string): Promise<boolean> {
    const resolved = resolve(path);
    const index = this.settings.allowedDirectories.indexOf(resolved);

    if (index === -1) {
      return false;
    }

    this.settings.allowedDirectories.splice(index, 1);

    // Clear default if it was removed
    if (this.settings.defaultDirectory === resolved) {
      this.settings.defaultDirectory = undefined;
    }

    await this.saveSettings();
    log.info({ path: resolved }, 'Removed directory from whitelist');
    return true;
  }

  /**
   * Check if a directory is allowed
   */
  isDirectoryAllowed(path: string): boolean {
    const resolved = resolve(path);
    return this.settings.allowedDirectories.includes(resolved);
  }

  /**
   * Get default directory
   */
  getDefaultDirectory(): string | undefined {
    return this.settings.defaultDirectory;
  }

  /**
   * Set default directory (must be in allowed list)
   */
  async setDefaultDirectory(path: string): Promise<boolean> {
    const resolved = resolve(path);
    if (!this.settings.allowedDirectories.includes(resolved)) {
      return false;
    }

    this.settings.defaultDirectory = resolved;
    await this.saveSettings();
    return true;
  }

  /**
   * Get max concurrent sessions limit (undefined = no limit)
   */
  getMaxSessions(): number | undefined {
    return this.settings.maxConcurrentSessions;
  }

  /**
   * Check if auto cleanup orphans is enabled
   */
  shouldAutoCleanupOrphans(): boolean {
    return this.settings.autoCleanupOrphans;
  }

  /**
   * Get terminal app setting (default: background)
   */
  getTerminalApp(): TerminalApp {
    return this.settings.terminalApp || 'background';
  }

  /**
   * Set terminal app
   */
  async setTerminalApp(app: TerminalApp): Promise<void> {
    this.settings.terminalApp = app;
    await this.saveSettings();
    log.info({ terminalApp: app }, 'Terminal app setting updated');
  }

  /**
   * Load settings from disk
   */
  private async loadSettings(): Promise<void> {
    try {
      await access(SETTINGS_FILE);
      const content = await readFile(SETTINGS_FILE, 'utf-8');
      const loaded = JSON.parse(content);

      // Merge with defaults
      this.settings = {
        version: 1,
        allowedDirectories: loaded.allowedDirectories || [],
        defaultDirectory: loaded.defaultDirectory,
        autoCleanupOrphans: loaded.autoCleanupOrphans ?? true,
        maxConcurrentSessions: loaded.maxConcurrentSessions,
        terminalApp: loaded.terminalApp,
      };

      log.info({ directories: this.settings.allowedDirectories.length }, 'Loaded settings');
    } catch {
      log.info('No existing settings, using defaults');
    }
  }

  /**
   * Save settings to disk
   */
  private async saveSettings(): Promise<void> {
    try {
      await mkdir(dirname(SETTINGS_FILE), { recursive: true });
      await writeFile(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      log.error({ err }, 'Failed to save settings');
    }
  }
}
