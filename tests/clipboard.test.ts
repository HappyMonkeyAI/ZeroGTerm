import { describe, expect, it } from 'vitest';
import { clipboardTextMatches, writeClipboardText } from '../src/main/clipboard';

/**
 * A clipboard that can refuse the first N writes, the way a busy Windows
 * clipboard owner does, and that stores CRLF like Windows does.
 */
function fakeClipboard({ refuseWrites = 0, crlf = false } = {}) {
  const state = { text: '', attempts: 0 };
  return {
    state,
    writeText(text: string) {
      state.attempts += 1;
      if (state.attempts <= refuseWrites) return;
      state.text = crlf ? text.replace(/\n/g, '\r\n') : text;
    },
    readText() {
      return state.text;
    }
  };
}

describe('clipboardTextMatches', () => {
  it('accepts the CRLF the Windows clipboard stores', () => {
    expect(clipboardTextMatches('one\ntwo', 'one\r\ntwo')).toBe(true);
    expect(clipboardTextMatches('one\r\ntwo', 'one\ntwo')).toBe(true);
  });

  it('rejects text that did not land', () => {
    expect(clipboardTextMatches('copied', '')).toBe(false);
    expect(clipboardTextMatches('copied', 'something else')).toBe(false);
  });
});

describe('writeClipboardText', () => {
  it('writes once when the clipboard cooperates', () => {
    const clipboard = fakeClipboard();
    expect(writeClipboardText(clipboard, 'copied')).toBe(true);
    expect(clipboard.state.attempts).toBe(1);
    expect(clipboard.state.text).toBe('copied');
  });

  it('retries a write another application blocked', () => {
    const clipboard = fakeClipboard({ refuseWrites: 1 });
    expect(writeClipboardText(clipboard, 'copied')).toBe(true);
    expect(clipboard.state.attempts).toBe(2);
    expect(clipboard.state.text).toBe('copied');
  });

  it('reports failure when the text never lands', () => {
    const clipboard = fakeClipboard({ refuseWrites: 5 });
    expect(writeClipboardText(clipboard, 'copied')).toBe(false);
    expect(clipboard.state.attempts).toBe(2);
  });

  it('does not treat line-ending translation as a failure', () => {
    const clipboard = fakeClipboard({ crlf: true });
    expect(writeClipboardText(clipboard, 'one\ntwo')).toBe(true);
    expect(clipboard.state.attempts).toBe(1);
  });
});
