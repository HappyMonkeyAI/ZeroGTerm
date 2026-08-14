// Clipboard wiring for a terminal pane: the Ctrl+Shift+C / Ctrl+Shift+V
// bindings, copy-on-select, and OSC 52 — the escape sequence a program running
// *inside* the terminal uses to put text on the system clipboard.
//
// Kept out of main.tsx so it can be unit tested against a fake terminal:
// main.tsx calls createRoot at module scope and cannot be imported from a test.

/** The clipboard half of the preload API (the real clipboard lives in main). */
export type ClipboardBridge = {
  copyText(text: string): Promise<void>;
  readText(): Promise<string>;
};

type Disposable = { dispose(): void };

/**
 * The slice of xterm's Terminal this module touches.
 *
 * `paste`, `onSelectionChange` and `parser` are optional because the previous
 * inline implementation feature-detected them, and a terminal built without
 * them should lose a binding rather than throw during pane setup.
 */
export type ClipboardTerminal = {
  getSelection(): string;
  paste?(text: string): void;
  attachCustomKeyEventHandler(handler: (event: ClipboardKeyEvent) => boolean): void;
  onSelectionChange?(listener: () => void): Disposable | void;
  parser?: {
    registerOscHandler(
      ident: number,
      handler: (data: string) => boolean | Promise<boolean>
    ): Disposable | void;
  };
};

/** The parts of a KeyboardEvent the shortcut handling needs. */
export type ClipboardKeyEvent = {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};

/** Where native paste events can be intercepted — the element hosting xterm. */
export type PasteEventTarget = {
  addEventListener(type: 'paste', listener: (event: Event) => void, capture: boolean): void;
  removeEventListener(type: 'paste', listener: (event: Event) => void, capture: boolean): void;
};

export type TerminalClipboardOptions = {
  terminal: ClipboardTerminal;
  clipboard: ClipboardBridge;
  /** Surfaced in the status bar — a clipboard that silently fails is the bug. */
  onError: (message: string) => void;
  /** Used only when the terminal has no paste() of its own. */
  writeToPty?: (text: string) => void;
  /** The pane element, so a duplicate native paste can be swallowed. */
  pasteEventTarget?: PasteEventTarget;
};

/** Coalesce the selection changes a single drag produces into one write. */
const SELECTION_COPY_DELAY_MS = 60;
/** How long after our own paste a native paste event is still its duplicate. */
const NATIVE_PASTE_GUARD_MS = 200;

export type ClipboardShortcut = 'copy' | 'paste';

/**
 * Linux terminal conventions: Ctrl+Shift+C copies, Ctrl+Shift+V pastes.
 * Only the Shift variants are claimed, so Ctrl+C stays the interrupt signal.
 */
export function classifyClipboardShortcut(event: ClipboardKeyEvent): ClipboardShortcut | null {
  if (event.type !== 'keydown') return null;
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'c') return 'copy';
  if (key === 'v') return 'paste';
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function insert(options: TerminalClipboardOptions, guard: PasteGuard, text: string): void {
  guard.mark();
  // Prefer xterm paste so bracketed-paste mode is honored when available.
  if (typeof options.terminal.paste === 'function') {
    options.terminal.paste(text);
    return;
  }
  options.writeToPty?.(text);
}

/**
 * Remembers that we just pasted, so a native paste event arriving right after
 * can be recognised as the browser's duplicate of it rather than a second
 * deliberate paste. See attachNativePasteGuard for why that happens.
 */
export type PasteGuard = {
  mark(): void;
  isDuplicate(): boolean;
};

export function createPasteGuard(now: () => number = () => Date.now()): PasteGuard {
  let pastedAt = Number.NEGATIVE_INFINITY;
  return {
    mark() { pastedAt = now(); },
    isDuplicate() { return now() - pastedAt < NATIVE_PASTE_GUARD_MS; }
  };
}

/**
 * Swallow the browser's own paste when it echoes one we just performed.
 *
 * Chromium turns Ctrl+Shift+V into "paste as plain text" on the focused
 * textarea, and xterm pastes whatever that event carries. Cancelling the
 * keydown normally stops it, but the two paths are independent, so this
 * catches any that still gets through: within the guard window a native paste
 * can only be the duplicate of ours, and cancelling it in the capture phase
 * stops it reaching xterm's listener.
 *
 * Outside that window native pasting is untouched, so Ctrl+V still works.
 */
export function attachNativePasteGuard(target: PasteEventTarget, guard: PasteGuard): () => void {
  const listener = (event: Event) => {
    if (!guard.isDuplicate()) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
  };
  target.addEventListener('paste', listener, true);
  return () => target.removeEventListener('paste', listener, true);
}

/**
 * The custom key handler xterm consults before it sends a key to the pty.
 *
 * Returning false only stops *xterm* from handling the key — xterm does not
 * cancel the event, so the browser still runs its own default action, and
 * Chromium maps Ctrl+Shift+V to "paste as plain text" on the focused textarea.
 * That native paste arrives as a paste event xterm also handles, so without
 * preventDefault the clipboard is inserted twice: the double-paste bug.
 */
export function createClipboardKeyHandler(
  options: TerminalClipboardOptions,
  guard: PasteGuard = createPasteGuard()
): (event: ClipboardKeyEvent) => boolean {
  return (event) => {
    const shortcut = classifyClipboardShortcut(event);
    if (!shortcut) return true;
    event.preventDefault();
    event.stopPropagation();

    if (shortcut === 'copy') {
      const selection = options.terminal.getSelection();
      if (selection) {
        void options.clipboard.copyText(selection).catch((error) => {
          options.onError(describeError(error));
        });
      }
      return false;
    }

    void options.clipboard.readText()
      .then((text) => {
        if (text) insert(options, guard, text);
      })
      .catch((error) => {
        options.onError(describeError(error));
      });
    return false;
  };
}

/** Targets that mean "the clipboard the user pastes from". */
const CLIPBOARD_TARGETS = new Set(['c', 'p', 's']);

/**
 * Which selection is an OSC 52 sequence addressing?
 *
 * The target field is a run of characters — `c`, `p`, `s`, or cut buffers
 * `0`-`7` — and an empty field means the default (`s0`). Everything but a
 * cut-buffer-only request maps onto the one clipboard this platform has.
 */
function targetsClipboard(targets: string): boolean {
  if (!targets) return true;
  return [...targets].some((target) => CLIPBOARD_TARGETS.has(target));
}

function decodeBase64Utf8(payload: string): string | null {
  // Long payloads are commonly wrapped, and the newlines are not data.
  const compact = payload.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null;
  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decode the body of an OSC 52 sequence — everything xterm hands the handler
 * after `52;`, i.e. `<targets>;<base64>`. Returns null when the sequence asks
 * for something this terminal deliberately will not do.
 *
 * xterm.js ships no OSC 52 handler, so before this a TUI that copies through
 * the terminal — Claude Code CLI reporting "Copied to clipboard", tmux,
 * neovim's `+` register over SSH — printed its success message while the text
 * went nowhere. That is the missing-clipboard-contents bug.
 */
export function decodeOsc52(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator === -1) return null;
  if (!targetsClipboard(data.slice(0, separator))) return null;

  const payload = data.slice(separator + 1);
  // `?` asks the terminal to send the clipboard *back* to the program. Any
  // process with a pty — including one on a remote host reached over SSH —
  // could then read whatever the user last copied, so it stays unimplemented.
  if (payload === '?') return null;
  // An empty payload technically means "clear the clipboard". Honouring it
  // would let a stray sequence in ordinary output wipe the user's clipboard,
  // which is the failure this whole module exists to stop.
  if (!payload) return null;

  return decodeBase64Utf8(payload);
}

/** Let programs inside the terminal write to the system clipboard (OSC 52). */
export function registerOsc52Clipboard(options: TerminalClipboardOptions): () => void {
  const parser = options.terminal.parser;
  if (!parser) return () => undefined;

  const registration = parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52(data);
    if (text !== null) {
      void options.clipboard.copyText(text).catch((error) => {
        options.onError(describeError(error));
      });
    }
    // Handled either way: an ignored OSC 52 must not fall through and print.
    return true;
  });

  return () => {
    if (registration && typeof registration.dispose === 'function') registration.dispose();
  };
}

/**
 * Copy-on-select, coalesced.
 *
 * xterm reports a selection change for every mouse move of a drag, and each
 * one used to be its own clipboard write. On Windows those writes contend for
 * the single system clipboard (and wake every clipboard-history watcher), so
 * only the settled selection is written, and only when it actually changed.
 */
export function attachSelectionCopy(options: TerminalClipboardOptions): () => void {
  const { terminal } = options;
  if (typeof terminal.onSelectionChange !== 'function') return () => undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCopied: string | null = null;

  const registration = terminal.onSelectionChange(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const selection = terminal.getSelection();
      // An empty selection means the user cleared it, not that they want an
      // empty clipboard: leave whatever was copied before in place.
      if (!selection || selection === lastCopied) return;
      lastCopied = selection;
      void options.clipboard.copyText(selection).catch((error) => {
        // A selection the user believes is copied but is not is the bug being
        // fixed here, so this failure is reported rather than swallowed.
        lastCopied = null;
        options.onError(describeError(error));
      });
    }, SELECTION_COPY_DELAY_MS);
  });

  return () => {
    if (timer) clearTimeout(timer);
    if (registration && typeof registration.dispose === 'function') registration.dispose();
  };
}

/** Wire every clipboard path for one pane; returns a teardown function. */
export function attachTerminalClipboard(options: TerminalClipboardOptions): () => void {
  const guard = createPasteGuard();
  // xterm has no detach for this, but the handler dies with the terminal.
  options.terminal.attachCustomKeyEventHandler(createClipboardKeyHandler(options, guard));
  const disposers = [
    registerOsc52Clipboard(options),
    attachSelectionCopy(options),
    options.pasteEventTarget ? attachNativePasteGuard(options.pasteEventTarget, guard) : () => undefined
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
