// What the editor decides about its text, kept apart from the overlay so the
// rules can be tested without a textarea.
//
// The one that matters most is line endings. A textarea reports its value with
// every line ending as a bare newline, so a CRLF file edited and saved as-is
// would come back with every line changed — a diff the user never made. The
// ending is therefore noted when the file is opened, the text edited as LF, and
// the ending put back on save.

import { MAX_EDIT_BYTES } from '../shared/editing';

export type LineEnding = 'lf' | 'crlf';

/** CRLF when most of the file's line breaks are, else LF. */
export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? 'crlf' : 'lf';
}

/** The text as the textarea holds it: every line break a bare newline. */
export function toEditorText(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** The text as it is written: the file's own line ending put back. */
export function fromEditorText(text: string, ending: LineEnding): string {
  return ending === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}

/** Whether there is anything to lose by closing. */
export function isDirty(saved: string, current: string): boolean {
  return saved !== current;
}

/** One-based line and column of the caret, for the footer. */
export function cursorPosition(text: string, caret: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const line = before.split('\n').length;
  return { line, column: before.length - (before.lastIndexOf('\n') + 1) + 1 };
}

/** Tab types a tab instead of leaving the box, replacing whatever is selected. */
export function insertTab(text: string, start: number, end: number): { text: string; caret: number } {
  return { text: `${text.slice(0, start)}\t${text.slice(end)}`, caret: start + 1 };
}

/** Whether what would be saved is more than the main process will write. */
export function exceedsSaveLimit(text: string): boolean {
  return new TextEncoder().encode(text).length > MAX_EDIT_BYTES;
}
