import { describe, expect, it } from 'vitest';
import {
  cursorPosition,
  detectLineEnding,
  exceedsSaveLimit,
  fromEditorText,
  insertTab,
  isDirty,
  toEditorText
} from '../src/renderer/editor-state';
import { MAX_EDIT_BYTES } from '../src/shared/editing';

describe('line endings', () => {
  it('reads a CRLF file as CRLF and an LF file as LF', () => {
    expect(detectLineEnding('a\r\nb\r\n')).toBe('crlf');
    expect(detectLineEnding('a\nb\n')).toBe('lf');
  });

  it('calls a file with no line break LF', () => {
    expect(detectLineEnding('one line')).toBe('lf');
    expect(detectLineEnding('')).toBe('lf');
  });

  it('goes with whichever kind most of the breaks are', () => {
    expect(detectLineEnding('a\r\nb\r\nc\n')).toBe('crlf');
    expect(detectLineEnding('a\nb\nc\r\n')).toBe('lf');
  });

  it('puts the original ending back, so an untouched file is unchanged', () => {
    for (const original of ['a\r\nb\r\n', 'a\nb\n', 'no break', '', '\r\n']) {
      expect(fromEditorText(toEditorText(original), detectLineEnding(original))).toBe(original);
    }
  });

  it('does not double the carriage return of a line already CRLF', () => {
    expect(fromEditorText('a\nb', 'crlf')).toBe('a\r\nb');
  });
});

describe('isDirty', () => {
  it('is false for the same text and true once it differs', () => {
    expect(isDirty('KEY=1', 'KEY=1')).toBe(false);
    expect(isDirty('KEY=1', 'KEY=2')).toBe(true);
  });

  it('is false again when an edit is typed back out', () => {
    expect(isDirty('abc', 'abcd'.slice(0, 3))).toBe(false);
  });
});

describe('cursorPosition', () => {
  it('counts from line 1, column 1', () => {
    expect(cursorPosition('', 0)).toEqual({ line: 1, column: 1 });
    expect(cursorPosition('abc', 0)).toEqual({ line: 1, column: 1 });
    expect(cursorPosition('abc', 3)).toEqual({ line: 1, column: 4 });
  });

  it('moves down a line after a newline', () => {
    expect(cursorPosition('ab\ncd', 3)).toEqual({ line: 2, column: 1 });
    expect(cursorPosition('ab\ncd', 5)).toEqual({ line: 2, column: 3 });
  });

  it('tolerates a caret outside the text', () => {
    expect(cursorPosition('ab', 99)).toEqual({ line: 1, column: 3 });
    expect(cursorPosition('ab', -5)).toEqual({ line: 1, column: 1 });
  });
});

describe('insertTab', () => {
  it('types a tab at the caret', () => {
    expect(insertTab('ab', 1, 1)).toEqual({ text: 'a\tb', caret: 2 });
  });

  it('replaces a selection', () => {
    expect(insertTab('abcd', 1, 3)).toEqual({ text: 'a\td', caret: 2 });
  });
});

describe('exceedsSaveLimit', () => {
  it('counts bytes, not characters', () => {
    expect(exceedsSaveLimit('x'.repeat(MAX_EDIT_BYTES))).toBe(false);
    expect(exceedsSaveLimit('x'.repeat(MAX_EDIT_BYTES + 1))).toBe(true);
    // Three bytes each: well under the limit in characters, over it in bytes.
    expect(exceedsSaveLimit('日'.repeat(Math.ceil(MAX_EDIT_BYTES / 3) + 1))).toBe(true);
  });
});
