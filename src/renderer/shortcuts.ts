// Which keypress means what, and which overlay Escape closes.
//
// This was a block of ifs inside a keydown effect in main.tsx, which is how
// Ctrl+Shift+A came to be advertised in a tooltip for two releases without ever
// being bound: there was nothing a test could ask. The decision is separated
// from the acting on it here, so the bindings can be enumerated — and so the
// list below can be checked against what the UI and the README claim.
//
// Only the Ctrl+Shift variants are ever claimed. A shell owns Ctrl+C, Ctrl+R,
// Ctrl+L and Ctrl+A, and taking any of those would break every pane, local and
// remote, for the sake of app chrome. xterm passes a Ctrl+Shift chord through to
// the pty as nothing at all, which is what makes them free to use — verified
// against a real bash rather than assumed.

/** The parts of a keyboard event a binding is decided from. */
export type ShortcutEvent = {
  key: string;
  /**
   * Needed as well as `key` for the chords whose character changes under Shift:
   * Shift+comma reports as `<` and Shift+1 as `!` on most layouts, so `key`
   * alone can never match them.
   */
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /**
   * Whether the keypress landed in one of the app's own text fields, such as the
   * inline workspace rename. A focused terminal is deliberately *not* one of
   * these: xterm's input is a textarea, and the shortcuts are meant to work
   * while a pane has the keyboard.
   */
  inTextField?: boolean;
};

export type ShortcutAction =
  | 'toggle-overview'
  | 'new-workspace'
  | 'new-terminal'
  | 'ask-ai'
  | 'toggle-layout'
  | 'toggle-sidebar'
  | 'toggle-settings'
  | 'history-palette';

export type Shortcut =
  | { action: ShortcutAction }
  /** Ctrl+Shift+1 … Ctrl+Shift+9, one-based as the tab order reads. */
  | { action: 'switch-workspace'; position: number };

/**
 * Every fixed binding, with the chord exactly as the UI writes it.
 *
 * The chord text is part of the contract, not decoration: tooltips and the
 * README are checked against these strings, so a binding cannot be advertised
 * under a name nothing answers to.
 */
export const SHORTCUTS: ReadonlyArray<{ chord: string; action: ShortcutAction; description: string }> = [
  { chord: 'Ctrl+Shift+O', action: 'toggle-overview', description: 'session overview' },
  { chord: 'Ctrl+Shift+N', action: 'new-workspace', description: 'new workspace' },
  { chord: 'Ctrl+Shift+T', action: 'new-terminal', description: 'new local terminal in the current workspace' },
  { chord: 'Ctrl+Shift+A', action: 'ask-ai', description: 'ask the AI endpoint for a command' },
  { chord: 'Ctrl+Shift+L', action: 'toggle-layout', description: 'fold to a single pane, or back to the last split' },
  { chord: 'Ctrl+Shift+B', action: 'toggle-sidebar', description: 'toggle sessions sidebar' },
  { chord: 'Ctrl+Shift+,', action: 'toggle-settings', description: 'settings' },
  { chord: 'Ctrl+Shift+R', action: 'history-palette', description: 'ranked command history palette' }
];

/** The letter chords, indexed by the lower-case letter they answer to. */
const BY_LETTER = new Map(
  SHORTCUTS.filter((entry) => /^Ctrl\+Shift\+[A-Z]$/.test(entry.chord)).map((entry) => [
    entry.chord.slice(-1).toLowerCase(),
    entry.action
  ])
);

const WORKSPACE_DIGIT = /^Digit([1-9])$/;

/**
 * The binding a keypress asks for, or null for one this app does not claim.
 *
 * Returning null rather than acting is the point: a chord with no binding must
 * reach the shell untouched.
 */
export function matchShortcut(event: ShortcutEvent): Shortcut | null {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return null;
  if (event.inTextField) return null;

  const letter = BY_LETTER.get(event.key.toLowerCase());
  if (letter) return { action: letter };

  // Matched on code for the same reason the comment on `code` gives: under Shift
  // these keys no longer report the character in the chord.
  if (event.code === 'Comma') return { action: 'toggle-settings' };
  const digit = WORKSPACE_DIGIT.exec(event.code);
  if (digit) return { action: 'switch-workspace', position: Number(digit[1]) };

  return null;
}

/**
 * The overlays Escape closes, outermost first.
 *
 * Order is the whole content of this list: with several open, Escape has to shut
 * the one the user is looking at. A pane's directory browser is deliberately
 * absent — it is part of the pane rather than an overlay, and Escape has to keep
 * reaching the shell for `vi` to be usable.
 */
export const DISMISS_ORDER = [
  'transfer',
  'settings',
  'voiceReview',
  'overview',
  'suggest',
  'modal',
  'palette',
  'history'
] as const;

export type DismissTarget = (typeof DISMISS_ORDER)[number];

/** Which overlay Escape should close, given what is open. */
export function topDismissTarget(open: Partial<Record<DismissTarget, boolean>>): DismissTarget | null {
  return DISMISS_ORDER.find((target) => open[target]) ?? null;
}
