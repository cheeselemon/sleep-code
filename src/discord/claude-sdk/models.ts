/**
 * Shared SDK model registry — single source of truth for the human-friendly
 * display name + context-window suffix that the user sees in Discord
 * (session-start pin, /claude start-sdk follow-ups, control panel hints).
 *
 * Keys mirror the model IDs that `/claude start-sdk` writes into customIds and
 * persists into `~/.sleep-code/sdk-session-mappings.json` (`sdkModel`).
 */
export const SDK_MODEL_DISPLAY: Record<string, string> = {
  'claude-opus-4-7[1m]': 'Opus 4.7 (1M)',
  'claude-opus-4-7': 'Opus 4.7 (200K)',
  'claude-opus-4-6[1m]': 'Opus 4.6 (1M)',
  'claude-opus-4-6': 'Opus 4.6 (200K)',
  'claude-sonnet-4-6[1m]': 'Sonnet 4.6 (1M)',
  'claude-sonnet-4-6': 'Sonnet 4.6 (200K)',
  'claude-haiku-4-5': 'Haiku 4.5 (200K)',
};

/**
 * Best-effort display name for an arbitrary model ID. Falls back to the raw ID
 * when an unknown variant slips in (e.g. legacy persisted mappings).
 */
export function formatSdkModelDisplay(modelId: string | undefined | null): string {
  if (!modelId) return 'unknown model';
  return SDK_MODEL_DISPLAY[modelId] ?? modelId;
}
