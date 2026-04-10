/**
 * Shared state management for Discord app
 */

// Tools whose results should be skipped in Discord (too verbose)
export const SKIP_RESULT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Task']);

// Image extensions that Claude can read
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

// Text extensions that can be attached as prompts
export const TEXT_EXTENSIONS = ['.txt'];

// Max text file size (100KB)
export const MAX_TEXT_FILE_SIZE = 100 * 1024;

// Full result TTL for cleanup
export const FULL_RESULT_TTL = 30 * 60 * 1000; // 30 minutes

// Max consecutive agent-to-agent routing before stopping (prevents infinite loops)
export const MAX_AGENT_ROUTING = 20;

export interface PendingQuestion {
  sessionId: string;
  toolUseId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export type PendingAnswerValue =
  | { kind: 'option'; label: string; optionIndex: number }
  | { kind: 'custom'; text: string }
  | { kind: 'multi'; labels: string[]; hasCustom: boolean; customText?: string };

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  resolve: (decision: { behavior: 'allow' | 'deny'; message?: string }) => void;
}

export interface ToolCallInfo {
  messageId: string;
  toolName: string;
  filePath?: string;
}

export interface FullResultData {
  content: string;
  toolName: string;
  createdAt: number;
}

export interface DiscordState {
  // Track messages sent from Discord to avoid re-posting
  discordSentMessages: Set<string>;

  // Track tool call messages for threading results
  toolCallMessages: Map<string, ToolCallInfo>;

  // Track pending AskUserQuestion interactions
  pendingQuestions: Map<string, PendingQuestion>;

  // Track multiSelect selections before submit
  pendingMultiSelections: Map<string, string[]>;

  // Track answers for multi-question AskUserQuestion
  pendingAnswers: Map<string, PendingAnswerValue>;

  // Track pending permission requests
  pendingPermissions: Map<string, PendingPermission>;

  // Track pending titles for sessions
  pendingTitles: Map<string, string>;

  // YOLO mode: auto-approve all permission requests
  yoloSessions: Set<string>;

  // Typing indicator intervals for running sessions
  typingIntervals: Map<string, NodeJS.Timeout>;

  // Store full results for "View Full" button
  pendingFullResults: Map<string, FullResultData>;

  // Cleanup interval reference
  fullResultsCleanupInterval: NodeJS.Timeout | null;

  // Track which agent was last active in each thread (for default routing)
  lastActiveAgent: Map<string, 'claude' | 'codex'>; // threadId -> agent type

  // Track consecutive agent-to-agent routing count (reset on user message)
  agentRoutingCount: Map<string, number>; // threadId -> count

  // SDK AskUserQuestion resolvers (requestId -> resolve with structured answers)
  sdkAskQuestionResolvers: Map<string, (answers: Record<string, PendingAnswerValue>) => void>;
}

/**
 * Create a new Discord state instance
 */
export function createState(): DiscordState {
  const state: DiscordState = {
    discordSentMessages: new Set(),
    toolCallMessages: new Map(),
    pendingQuestions: new Map(),
    pendingMultiSelections: new Map(),
    pendingAnswers: new Map(),
    pendingPermissions: new Map(),
    pendingTitles: new Map(),
    yoloSessions: new Set(),
    typingIntervals: new Map(),
    pendingFullResults: new Map(),
    fullResultsCleanupInterval: null,
    lastActiveAgent: new Map(),
    agentRoutingCount: new Map(),
    sdkAskQuestionResolvers: new Map(),
  };

  // Start periodic cleanup of expired pendingFullResults
  state.fullResultsCleanupInterval = setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [resultId, data] of state.pendingFullResults) {
      if (now - data.createdAt > FULL_RESULT_TTL) {
        state.pendingFullResults.delete(resultId);
        cleaned++;
      }
    }
    // Cleanup logging is handled by the caller if needed
  }, 5 * 60 * 1000);

  return state;
}

/**
 * Cleanup state resources
 */
export function cleanupState(state: DiscordState): void {
  if (state.fullResultsCleanupInterval) {
    clearInterval(state.fullResultsCleanupInterval);
  }
  for (const interval of state.typingIntervals.values()) {
    clearInterval(interval);
  }
  state.typingIntervals.clear();
}

/**
 * Helper to check if all questions are answered and get answers
 */
export function getAllAnswers(
  state: DiscordState,
  toolUseId: string
): Record<string, PendingAnswerValue> | null {
  const pending = state.pendingQuestions.get(toolUseId);
  if (!pending) return null;

  const totalQuestions = pending.questions.length;
  const answers: Record<string, PendingAnswerValue> = {};

  for (let i = 0; i < totalQuestions; i++) {
    const answerKey = `${toolUseId}:${i}`;
    const answer = state.pendingAnswers.get(answerKey);
    if (!answer) {
      return null; // Not all questions answered yet
    }
    answers[i.toString()] = answer;
  }

  return answers;
}

/**
 * Convert structured PendingAnswerValue to flat strings (for PTY sessions)
 */
export function flattenAnswers(answers: Record<string, PendingAnswerValue>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, val] of Object.entries(answers)) {
    if (val.kind === 'option') {
      flat[key] = val.label;
    } else if (val.kind === 'custom') {
      flat[key] = val.text;
    } else if (val.kind === 'multi') {
      flat[key] = val.labels.join(', ');
    }
  }
  return flat;
}

/**
 * Clean up question-related state after submission
 */
export function cleanupQuestionState(state: DiscordState, toolUseId: string): void {
  const pending = state.pendingQuestions.get(toolUseId);
  if (!pending) return;

  for (let i = 0; i < pending.questions.length; i++) {
    state.pendingAnswers.delete(`${toolUseId}:${i}`);
    state.pendingMultiSelections.delete(`${toolUseId}:${i}`);
  }
  state.pendingQuestions.delete(toolUseId);
}
