/**
 * Memory system configuration loader
 *
 * Loads from ~/.sleep-code/memory-config.json with hot-reload support.
 * Falls back to sensible defaults if file is missing or corrupt.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, watchFile, unwatchFile } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../utils/logger.js';

const log = logger.child({ component: 'memory-config' });

const CONFIG_DIR = join(homedir(), '.sleep-code');
const CONFIG_FILE = join(CONFIG_DIR, 'memory-config.json');

// ── Schema ──────────────────────────────────────────────────

export interface DistillConfig {
  /** Master switch for distill pipeline */
  enabled: boolean;
  /** SDK model for distill (haiku recommended) */
  model: string;
  /** Trigger batch when queue reaches this count */
  batchMaxMessages: number;
  /** Trigger batch after this interval (ms) even if queue < max */
  batchIntervalMs: number;
  /** Recreate SDK session after this interval (ms) to keep context fresh */
  sessionRefreshMs: number;
  /** How much skip detail to show: 'count' = just count, 'list' = show each */
  skipVerbosity: 'count' | 'list';
  /** Project names to exclude from distill */
  excludeProjects: string[];
  /** Discord channel IDs to exclude from distill */
  excludeChannels: string[];
}

export interface ConsolidationConfig {
  /** Master switch for consolidation */
  enabled: boolean;
  /** Run consolidation every N ms */
  intervalMs: number;
}

export interface DigestConfig {
  /** Master switch for daily digest */
  enabled: boolean;
  /** Times to send digest (HH:MM in 24h format) */
  schedule: string[];
  /** Timezone for schedule (IANA format) */
  timezone: string;
  /** SDK model for digest generation (sonnet recommended) */
  model: string;
}

export interface MemoryConfig {
  distill: DistillConfig;
  consolidation: ConsolidationConfig;
  digest: DigestConfig;
}

// ── Defaults ────────────────────────────────────────────────

const DEFAULT_CONFIG: MemoryConfig = {
  distill: {
    enabled: true,
    model: 'haiku',
    batchMaxMessages: 20,
    batchIntervalMs: 30 * 60 * 1000,   // 30 minutes
    sessionRefreshMs: 2 * 60 * 60 * 1000, // 2 hours
    skipVerbosity: 'count',
    excludeProjects: [],
    excludeChannels: [],
  },
  consolidation: {
    enabled: true,
    intervalMs: 24 * 60 * 60 * 1000,   // 24 hours
  },
  digest: {
    enabled: true,
    schedule: ['10:00', '16:00'],
    timezone: 'Asia/Seoul',
    model: 'sonnet',
  },
};

// ── Loader ──────────────────────────────────────────────────

type ConfigListener = (config: MemoryConfig) => void;

let cachedConfig: MemoryConfig = structuredClone(DEFAULT_CONFIG);
let watching = false;
const listeners: Set<ConfigListener> = new Set();

/** Deep merge src into target, preserving target keys not in src */
function deepMerge<T extends Record<string, any>>(target: T, src: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(src) as (keyof T)[]) {
    const srcVal = src[key];
    if (srcVal === undefined) continue;
    if (
      typeof srcVal === 'object' &&
      srcVal !== null &&
      !Array.isArray(srcVal) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key] as any, srcVal as any);
    } else {
      result[key] = srcVal as T[keyof T];
    }
  }
  return result;
}

async function loadFromDisk(): Promise<MemoryConfig> {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return structuredClone(DEFAULT_CONFIG);
    }
    const raw = await readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return deepMerge(structuredClone(DEFAULT_CONFIG), parsed);
  } catch (err) {
    log.warn({ err }, 'Failed to load memory-config.json, using defaults');
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * Load config from disk and start watching for changes.
 * Safe to call multiple times (idempotent watch).
 */
export async function loadMemoryConfig(): Promise<MemoryConfig> {
  cachedConfig = await loadFromDisk();
  log.info({ config: cachedConfig }, 'Memory config loaded');

  // Start file watcher (if not already running)
  if (!watching) {
    startWatcher();
  }

  return cachedConfig;
}

/** Get the current cached config (synchronous) */
export function getMemoryConfig(): MemoryConfig {
  return cachedConfig;
}

/** Subscribe to config changes */
export function onConfigChange(listener: ConfigListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Save the current config to disk */
export async function saveMemoryConfig(config: MemoryConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const json = JSON.stringify(config, null, 2) + '\n';
  await writeFile(CONFIG_FILE, json, 'utf-8');
  cachedConfig = config;
  log.info('Memory config saved');
}

/** Update a single section and save */
export async function updateMemoryConfig(
  patch: Partial<MemoryConfig>,
): Promise<MemoryConfig> {
  const updated = deepMerge(cachedConfig, patch);
  await saveMemoryConfig(updated);
  notifyListeners(updated);
  return updated;
}

/** Stop watching config file */
export function stopConfigWatcher(): void {
  if (watching) {
    unwatchFile(CONFIG_FILE);
    watching = false;
  }
}

// ── File watcher (polling, reliable on macOS) ───────────────

function startWatcher(): void {
  if (!existsSync(CONFIG_FILE)) return;
  watching = true;
  watchFile(CONFIG_FILE, { interval: 2000 }, async () => {
    try {
      const newConfig = await loadFromDisk();
      const changed = JSON.stringify(newConfig) !== JSON.stringify(cachedConfig);
      if (!changed) return;
      cachedConfig = newConfig;
      log.info({ config: newConfig }, 'Memory config hot-reloaded');
      notifyListeners(newConfig);
    } catch {
      // ignore parse errors during hot reload
    }
  });
}

function notifyListeners(config: MemoryConfig): void {
  for (const fn of listeners) {
    try {
      fn(config);
    } catch (err) {
      log.warn({ err }, 'Config change listener error');
    }
  }
}

/** Ensure default config file exists (non-destructive) */
export async function ensureConfigFile(): Promise<void> {
  if (existsSync(CONFIG_FILE)) return;
  await mkdir(CONFIG_DIR, { recursive: true });
  await saveMemoryConfig(structuredClone(DEFAULT_CONFIG));
  log.info('Created default memory-config.json');
}
