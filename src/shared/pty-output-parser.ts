/**
 * PTY Output Parser
 *
 * Parses PTY stdout to extract assistant messages that may not be recorded in JSONL.
 * Handles ANSI escape sequences and detects message boundaries.
 */

import stripAnsi from 'strip-ansi';

// Braille spinner characters used by Claude Code
const SPINNER_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐⠂⠄⠠⠈⠁✓✗✳●○◐◑◒◓]/g;

// OSC (Operating System Command) title sequence
const OSC_TITLE_PATTERN = /\x1b\](?:0|2);[^\x07\x1b]*?(?:\x07|\x1b\\)/g;

// Common prompt patterns that indicate end of assistant output
const PROMPT_PATTERNS = [
  /^>\s*$/m,           // Simple prompt
  /^claude>\s*$/m,     // Claude prompt
  /^\$\s*$/m,          // Shell prompt
];

export interface ParsedPtyOutput {
  content: string;
  isThinking: boolean;
  hasSpinner: boolean;
  timestamp: number;
}

export class PtyOutputParser {
  private buffer = '';
  private lastEmittedContent = '';
  private debounceTimer: NodeJS.Timeout | null = null;
  private onOutput: ((output: ParsedPtyOutput) => void) | null = null;

  constructor(onOutput?: (output: ParsedPtyOutput) => void) {
    this.onOutput = onOutput || null;
  }

  /**
   * Process raw PTY data
   */
  process(data: string): void {
    this.buffer += data;

    // Limit buffer size to prevent memory issues
    if (this.buffer.length > 50000) {
      this.buffer = this.buffer.slice(-50000);
    }

    // Check for spinner (thinking state)
    const hasSpinner = SPINNER_PATTERN.test(data);

    // Clean the data
    let cleaned = this.cleanOutput(this.buffer);

    // Skip if no meaningful content
    if (!cleaned.trim()) {
      // But still emit thinking state if spinner detected
      if (hasSpinner && this.onOutput) {
        this.onOutput({
          content: '',
          isThinking: true,
          hasSpinner: true,
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Debounce output to avoid flooding
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.emitOutput(cleaned, hasSpinner);
      this.debounceTimer = null;
    }, 150); // 150ms debounce
  }

  /**
   * Clean PTY output by removing ANSI codes and other noise
   */
  private cleanOutput(raw: string): string {
    let cleaned = raw;

    // Remove OSC title sequences
    cleaned = cleaned.replace(OSC_TITLE_PATTERN, '');

    // Strip ANSI escape codes
    cleaned = stripAnsi(cleaned);

    // Remove spinner characters
    cleaned = cleaned.replace(SPINNER_PATTERN, '');

    // Remove common control characters
    cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

    // Normalize whitespace
    cleaned = cleaned.replace(/\r\n/g, '\n');
    cleaned = cleaned.replace(/\r/g, '\n');

    // Remove excessive blank lines
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    return cleaned.trim();
  }

  /**
   * Emit parsed output if it's new content
   */
  private emitOutput(content: string, hasSpinner: boolean): void {
    // Skip if same as last emitted
    if (content === this.lastEmittedContent) {
      return;
    }

    // Find new content (delta from last emission)
    let newContent = content;
    if (this.lastEmittedContent && content.startsWith(this.lastEmittedContent)) {
      newContent = content.slice(this.lastEmittedContent.length).trim();
    }

    if (!newContent) {
      return;
    }

    this.lastEmittedContent = content;

    if (this.onOutput) {
      this.onOutput({
        content: newContent,
        isThinking: hasSpinner,
        hasSpinner,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Reset parser state (call on session end)
   */
  reset(): void {
    this.buffer = '';
    this.lastEmittedContent = '';
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Force flush any pending content
   */
  flush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const cleaned = this.cleanOutput(this.buffer);
    if (cleaned && cleaned !== this.lastEmittedContent) {
      this.emitOutput(cleaned, false);
    }

    this.buffer = '';
  }
}
