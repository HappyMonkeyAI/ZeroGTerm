import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachNativePasteGuard,
  attachSelectionCopy,
  attachTerminalClipboard,
  classifyClipboardShortcut,
  createClipboardKeyHandler,
  createPasteGuard,
  decodeOsc52,
  registerOsc52Clipboard
} from '../src/renderer/terminal-clipboard';
import type { ClipboardKeyEvent, ClipboardTerminal } from '../src/renderer/terminal-clipboard';

function keyEvent(overrides: Partial<ClipboardKeyEvent> = {}) {
  const event = {
    type: 'keydown',
    key: 'v',
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    prevented: 0,
    stopped: 0,
    preventDefault() { event.prevented += 1; },
    stopPropagation() { event.stopped += 1; },
    ...overrides
  };
  return event as ClipboardKeyEvent & { prevented: number; stopped: number };
}

function fakeClipboard(initial = '') {
  const state = { text: initial, writes: [] as string[], failWith: null as Error | null };
  return {
    state,
    copyText: vi.fn(async (text: string) => {
      if (state.failWith) throw state.failWith;
      state.writes.push(text);
      state.text = text;
    }),
    readText: vi.fn(async () => state.text)
  };
}

function fakeTerminal(overrides: Partial<ClipboardTerminal> = {}) {
  const state = {
    selection: '',
    pasted: [] as string[],
    keyHandlers: [] as Array<(event: ClipboardKeyEvent) => boolean>,
    selectionListeners: [] as Array<() => void>,
    oscHandlers: new Map<number, (data: string) => boolean | Promise<boolean>>(),
    disposed: [] as string[]
  };
  const terminal: ClipboardTerminal = {
    getSelection: () => state.selection,
    paste: (text: string) => { state.pasted.push(text); },
    attachCustomKeyEventHandler: (handler) => { state.keyHandlers.push(handler); },
    onSelectionChange: (listener) => {
      state.selectionListeners.push(listener);
      return { dispose: () => state.disposed.push('selection') };
    },
    parser: {
      registerOscHandler: (ident, handler) => {
        state.oscHandlers.set(ident, handler);
        return { dispose: () => state.disposed.push(`osc:${ident}`) };
      }
    },
    ...overrides
  };
  return { terminal, state };
}

describe('classifyClipboardShortcut', () => {
  it('claims Ctrl+Shift+C and Ctrl+Shift+V', () => {
    expect(classifyClipboardShortcut(keyEvent({ key: 'c' }))).toBe('copy');
    expect(classifyClipboardShortcut(keyEvent({ key: 'v' }))).toBe('paste');
    expect(classifyClipboardShortcut(keyEvent({ key: 'V' }))).toBe('paste');
    expect(classifyClipboardShortcut(keyEvent({ key: 'v', ctrlKey: false, metaKey: true }))).toBe('paste');
  });

  it('leaves Ctrl+C as the interrupt signal', () => {
    expect(classifyClipboardShortcut(keyEvent({ key: 'c', shiftKey: false }))).toBeNull();
    expect(classifyClipboardShortcut(keyEvent({ key: 'v', shiftKey: false }))).toBeNull();
  });

  it('ignores other keys and non-keydown events', () => {
    expect(classifyClipboardShortcut(keyEvent({ key: 'x' }))).toBeNull();
    expect(classifyClipboardShortcut(keyEvent({ type: 'keyup' }))).toBeNull();
  });
});

describe('createClipboardKeyHandler', () => {
  it('cancels the event so Chromium does not paste a second copy', async () => {
    // Returning false only stops xterm; the browser's own Ctrl+Shift+V
    // "paste as plain text" would otherwise fire too and paste twice.
    const clipboard = fakeClipboard('hello');
    const { terminal, state } = fakeTerminal();
    const handler = createClipboardKeyHandler({ terminal, clipboard, onError: () => undefined });

    const event = keyEvent({ key: 'v' });
    expect(handler(event)).toBe(false);
    expect(event.prevented).toBe(1);
    expect(event.stopped).toBe(1);

    await vi.waitFor(() => expect(state.pasted).toEqual(['hello']));
  });

  it('pastes nothing when the clipboard is empty', async () => {
    const clipboard = fakeClipboard('');
    const { terminal, state } = fakeTerminal();
    const handler = createClipboardKeyHandler({ terminal, clipboard, onError: () => undefined });

    handler(keyEvent({ key: 'v' }));
    await Promise.resolve();
    expect(state.pasted).toEqual([]);
  });

  it('falls back to the pty when the terminal cannot paste', async () => {
    const clipboard = fakeClipboard('hello');
    const written: string[] = [];
    const { terminal } = fakeTerminal({ paste: undefined });
    const handler = createClipboardKeyHandler({
      terminal,
      clipboard,
      onError: () => undefined,
      writeToPty: (text) => written.push(text)
    });

    handler(keyEvent({ key: 'v' }));
    await vi.waitFor(() => expect(written).toEqual(['hello']));
  });

  it('copies the selection, and reports a failed write', async () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    const errors: string[] = [];
    const handler = createClipboardKeyHandler({ terminal, clipboard, onError: (m) => errors.push(m) });

    state.selection = 'selected text';
    expect(handler(keyEvent({ key: 'c' }))).toBe(false);
    await vi.waitFor(() => expect(clipboard.state.writes).toEqual(['selected text']));

    clipboard.state.failWith = new Error('Clipboard write failed');
    handler(keyEvent({ key: 'c' }));
    await vi.waitFor(() => expect(errors).toEqual(['Clipboard write failed']));
  });

  it('does not clear the clipboard when nothing is selected', async () => {
    const clipboard = fakeClipboard('kept');
    const { terminal } = fakeTerminal();
    const handler = createClipboardKeyHandler({ terminal, clipboard, onError: () => undefined });

    handler(keyEvent({ key: 'c' }));
    await Promise.resolve();
    expect(clipboard.copyText).not.toHaveBeenCalled();
    expect(clipboard.state.text).toBe('kept');
  });

  it('passes every other key through to xterm untouched', () => {
    const clipboard = fakeClipboard();
    const { terminal } = fakeTerminal();
    const handler = createClipboardKeyHandler({ terminal, clipboard, onError: () => undefined });

    const event = keyEvent({ key: 'c', shiftKey: false });
    expect(handler(event)).toBe(true);
    expect(event.prevented).toBe(0);
  });
});

describe('decodeOsc52', () => {
  it('decodes a clipboard write', () => {
    expect(decodeOsc52('c;SGVsbG8sIHdvcmxk')).toBe('Hello, world');
    expect(decodeOsc52('p;SGVsbG8=')).toBe('Hello');
    expect(decodeOsc52(';SGVsbG8=')).toBe('Hello');
    expect(decodeOsc52('s0;SGVsbG8=')).toBe('Hello');
  });

  it('decodes multi-byte UTF-8, which byte-wise decoding would mangle', () => {
    // "naïve ✓" encoded as UTF-8 then base64.
    const text = 'naïve ✓';
    const base64 = Buffer.from(text, 'utf8').toString('base64');
    expect(decodeOsc52(`c;${base64}`)).toBe(text);
  });

  it('accepts payloads wrapped across lines', () => {
    const base64 = Buffer.from('a'.repeat(200), 'utf8').toString('base64');
    const wrapped = `${base64.slice(0, 40)}\n${base64.slice(40)}`;
    expect(decodeOsc52(`c;${wrapped}`)).toBe('a'.repeat(200));
  });

  it('refuses the read query, so a remote program cannot exfiltrate the clipboard', () => {
    expect(decodeOsc52('c;?')).toBeNull();
  });

  it('ignores malformed, empty and cut-buffer-only sequences', () => {
    expect(decodeOsc52('c;not base64!')).toBeNull();
    expect(decodeOsc52('c;')).toBeNull();
    expect(decodeOsc52('nosemicolon')).toBeNull();
    expect(decodeOsc52('0;SGVsbG8=')).toBeNull();
  });
});

describe('registerOsc52Clipboard', () => {
  it('puts text a program in the terminal copies onto the system clipboard', async () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    registerOsc52Clipboard({ terminal, clipboard, onError: () => undefined });

    const handler = state.oscHandlers.get(52);
    expect(handler).toBeTypeOf('function');
    expect(handler!('c;Q29waWVkIQ==')).toBe(true);
    await vi.waitFor(() => expect(clipboard.state.writes).toEqual(['Copied!']));
  });

  it('consumes ignored sequences instead of letting them print', async () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    registerOsc52Clipboard({ terminal, clipboard, onError: () => undefined });

    expect(state.oscHandlers.get(52)!('c;?')).toBe(true);
    await Promise.resolve();
    expect(clipboard.copyText).not.toHaveBeenCalled();
  });

  it('disposes its handler', () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    registerOsc52Clipboard({ terminal, clipboard, onError: () => undefined })();
    expect(state.disposed).toContain('osc:52');
  });

  it('is skipped on a terminal without a parser', () => {
    const clipboard = fakeClipboard();
    const { terminal } = fakeTerminal({ parser: undefined });
    expect(() => registerOsc52Clipboard({ terminal, clipboard, onError: () => undefined })()).not.toThrow();
  });
});

describe('attachSelectionCopy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes once for a drag, not once per selection change', () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    attachSelectionCopy({ terminal, clipboard, onError: () => undefined });

    for (const selection of ['h', 'he', 'hel', 'hello']) {
      state.selection = selection;
      state.selectionListeners[0]();
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(100);

    expect(clipboard.state.writes).toEqual(['hello']);
  });

  it('leaves the clipboard alone when the selection is cleared', () => {
    const clipboard = fakeClipboard('kept');
    const { terminal, state } = fakeTerminal();
    attachSelectionCopy({ terminal, clipboard, onError: () => undefined });

    state.selection = '';
    state.selectionListeners[0]();
    vi.advanceTimersByTime(100);

    expect(clipboard.copyText).not.toHaveBeenCalled();
    expect(clipboard.state.text).toBe('kept');
  });

  it('does not rewrite an unchanged selection', () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    attachSelectionCopy({ terminal, clipboard, onError: () => undefined });

    state.selection = 'same';
    state.selectionListeners[0]();
    vi.advanceTimersByTime(100);
    state.selectionListeners[0]();
    vi.advanceTimersByTime(100);

    expect(clipboard.state.writes).toEqual(['same']);
  });

  it('reports a failed copy-on-select and retries it next time', async () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    const errors: string[] = [];
    attachSelectionCopy({ terminal, clipboard, onError: (message) => errors.push(message) });

    clipboard.state.failWith = new Error('Clipboard write failed');
    state.selection = 'hello';
    state.selectionListeners[0]();
    vi.advanceTimersByTime(100);
    await vi.waitFor(() => expect(errors).toEqual(['Clipboard write failed']));

    // The same selection must be retried: it was never actually copied.
    clipboard.state.failWith = null;
    state.selectionListeners[0]();
    vi.advanceTimersByTime(100);
    await vi.waitFor(() => expect(clipboard.state.writes).toEqual(['hello']));
  });

  it('copies nothing while copy-on-select is switched off', () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    let enabled = false;
    attachSelectionCopy({ terminal, clipboard, onError: () => undefined, isCopyOnSelectEnabled: () => enabled });

    state.selection = 'hello';
    state.selectionListeners[0]();
    vi.advanceTimersByTime(100);
    expect(clipboard.copyText).not.toHaveBeenCalled();

    // The setting is read per selection, so turning it on needs no re-attach.
    enabled = true;
    state.selectionListeners[0]();
    vi.advanceTimersByTime(100);
    expect(clipboard.state.writes).toEqual(['hello']);
  });

  it('drops a pending copy when the pane goes away', () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    const detach = attachSelectionCopy({ terminal, clipboard, onError: () => undefined });

    state.selection = 'hello';
    state.selectionListeners[0]();
    detach();
    vi.advanceTimersByTime(100);

    expect(clipboard.copyText).not.toHaveBeenCalled();
    expect(state.disposed).toContain('selection');
  });
});

function fakePasteTarget() {
  const listeners: Array<(event: Event) => void> = [];
  let removed = 0;
  return {
    listeners,
    removedCount: () => removed,
    target: {
      addEventListener: (_type: 'paste', listener: (event: Event) => void) => { listeners.push(listener); },
      removeEventListener: () => { removed += 1; }
    },
    dispatch() {
      const event = { prevented: 0, stopped: 0, immediate: 0 };
      const domEvent = {
        preventDefault() { event.prevented += 1; },
        stopPropagation() { event.stopped += 1; },
        stopImmediatePropagation() { event.immediate += 1; }
      } as unknown as Event;
      for (const listener of listeners) listener(domEvent);
      return event;
    }
  };
}

describe('attachNativePasteGuard', () => {
  it('swallows the browser paste that echoes one we just performed', () => {
    let now = 1_000;
    const guard = createPasteGuard(() => now);
    const paste = fakePasteTarget();
    attachNativePasteGuard(paste.target, guard);

    guard.mark();
    now += 10;
    const duplicate = paste.dispatch();
    expect(duplicate.prevented).toBe(1);
    expect(duplicate.stopped).toBe(1);
  });

  it('leaves a later, deliberate paste alone', () => {
    let now = 1_000;
    const guard = createPasteGuard(() => now);
    const paste = fakePasteTarget();
    attachNativePasteGuard(paste.target, guard);

    guard.mark();
    now += 500;
    expect(paste.dispatch().prevented).toBe(0);
  });

  it('leaves a paste alone when we have not pasted at all', () => {
    const paste = fakePasteTarget();
    attachNativePasteGuard(paste.target, createPasteGuard(() => 1_000));
    expect(paste.dispatch().prevented).toBe(0);
  });
});

describe('attachTerminalClipboard', () => {
  it('wires the shortcuts, OSC 52 and copy-on-select together', () => {
    const clipboard = fakeClipboard();
    const { terminal, state } = fakeTerminal();
    const detach = attachTerminalClipboard({ terminal, clipboard, onError: () => undefined });

    expect(state.keyHandlers).toHaveLength(1);
    expect(state.oscHandlers.has(52)).toBe(true);
    expect(state.selectionListeners).toHaveLength(1);

    detach();
    expect(state.disposed).toEqual(['selection', 'osc:52']);
  });

  it('inserts the clipboard once when both paste paths fire', async () => {
    const clipboard = fakeClipboard('once');
    const { terminal, state } = fakeTerminal();
    const paste = fakePasteTarget();
    attachTerminalClipboard({
      terminal,
      clipboard,
      onError: () => undefined,
      pasteEventTarget: paste.target
    });

    state.keyHandlers[0](keyEvent({ key: 'v' }));
    await vi.waitFor(() => expect(state.pasted).toEqual(['once']));

    // Chromium's own Ctrl+Shift+V paste, had preventDefault not stopped it.
    const echoed = paste.dispatch();
    expect(echoed.prevented).toBe(1);
    expect(state.pasted).toEqual(['once']);
  });

  it('removes the paste listener on teardown', () => {
    const clipboard = fakeClipboard();
    const { terminal } = fakeTerminal();
    const paste = fakePasteTarget();
    attachTerminalClipboard({ terminal, clipboard, onError: () => undefined, pasteEventTarget: paste.target })();
    expect(paste.removedCount()).toBe(1);
  });
});
