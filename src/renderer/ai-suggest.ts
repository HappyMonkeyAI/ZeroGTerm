// The suggestion dialog's shape, and the one safety rule the renderer owns.
//
// Kept out of main.tsx so both can be unit tested — main.tsx calls createRoot at
// module scope and cannot be imported from a test — and so that "may this run
// without being seen" is answered in one place rather than at the call site.

import type { AiSettings } from './settings';
import type { AiSuggestion } from '../shared/types';

/**
 * Where the dialog is: asking what is wanted, waiting, or showing an answer.
 *
 * One dialog that changes rather than a prompt followed by a separate approval
 * box. The request and the answer belong to the same moment, and a second dialog
 * appearing where the first was is a worse way to say so.
 */
export type SuggestPhase =
  | { phase: 'asking'; sessionId?: string; prompt: string }
  | { phase: 'thinking'; sessionId?: string; prompt: string; usedOutput: boolean }
  | {
      phase: 'reviewing';
      sessionId?: string;
      prompt: string;
      usedOutput: boolean;
      suggestion: AiSuggestion;
    }
  | { phase: 'failed'; sessionId?: string; prompt: string; message: string };

export function askSuggestion(sessionId?: string): SuggestPhase {
  return { phase: 'asking', sessionId, prompt: '' };
}

/**
 * Whether a suggestion may be sent to a terminal without being shown first.
 *
 * The rule, in one testable place: auto-run survives only for the configuration
 * where nothing but shell, directory and host was sent. Once terminal output is
 * in the prompt, the model's answer is downstream of text a remote host chose,
 * and a command chosen that way must be seen before it runs.
 *
 * An empty command is never runnable either — that is what a reply which did not
 * parse produces, and there is nothing to send.
 */
export function canAutoRun(ai: Pick<AiSettings, 'requireApproval' | 'includeOutput'>, usedOutput: boolean, command: string): boolean {
  if (!command.trim()) return false;
  if (usedOutput || ai.includeOutput) return false;
  return !ai.requireApproval;
}

/**
 * Whether the settings allow output to be sent at all.
 *
 * Separate from the setting itself because the endpoint matters too: there is
 * nothing to send output to until a base URL and a model are configured, and a
 * prompt built against a missing endpoint would fail for the wrong reason.
 */
export function isConfigured(ai: Pick<AiSettings, 'baseUrl' | 'model'>): boolean {
  return Boolean(ai.baseUrl.trim() && ai.model.trim());
}

/**
 * The last `maxChars` of text, cut at a line boundary.
 *
 * Cutting mid-line would hand the model half a stack frame and invite it to
 * guess at the rest, so the first partial line is dropped. A short input is
 * returned whole rather than padded.
 */
export function boundedTail(text: string, maxChars: number): string {
  const trimmed = text.replace(/\s+$/, '');
  if (maxChars <= 0) return '';
  if (trimmed.length <= maxChars) return trimmed;
  const tail = trimmed.slice(-maxChars);
  const firstBreak = tail.indexOf('\n');
  // Only drop the partial line when something is left after it; a single line
  // longer than the cap is better truncated than discarded.
  if (firstBreak >= 0 && firstBreak < tail.length - 1) return tail.slice(firstBreak + 1);
  return tail;
}
