// Which keypress means what, and which overlay Escape closes.
//
// This was a block of ifs inside a keydown effect in main.tsx, which is how
// Ctrl+Shift+A came to be advertised in a tooltip for two releases without ever
// being bound: there was nothing a test could ask. The decision is separated
// from the acting on it here, so the bindings can be enumerated — and so what
// the interface and the README claim can be checked against them.
//
// The bindings are rebindable, because a chord this app is happy with can
// already be taken on the machine it runs on: Ctrl+Shift+T was reported taken on
// Windows 11, Teams claims Ctrl+Shift+O globally during a call, and Windows uses
// Ctrl+Shift by itself to switch keyboard layout when more than one is
// installed. Nothing here can win those fights, so the user gets to move ours
// out of the way instead.
//
// A chord is text — `Ctrl+Shift+T` — in one canonical order, and matching works
// by turning the event back into that text. That gives one rule for letters,
// digits and punctuation, in a form that can be stored in settings, shown in a
// tooltip, and compared against what the user pressed.

/** The parts of a keyboard event a binding is decided from. */
export type ShortcutEvent = {
  key: string;
  /**
   * The physical key, which is what a chord is written in terms of: Shift turns
   * a comma into `<` and a `1` into `!`, so `key` alone can never name them.
   */
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
  /**
   * Whether the keypress landed in one of the app's own text fields, such as the
   * inline workspace rename. A focused terminal is deliberately *not* one of
   * these: xterm's input is a textarea, and the shortcuts are meant to work
   * while a pane has the keyboard.
   */
  inTextField?: boolean;
};

export type ShortcutAction =
  | 'toggle-help'
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
  /** Ctrl+Shift+1 … Ctrl+Shift+9, one-based as the tab strip reads. */
  | { action: 'switch-workspace'; position: number };

/** What each action does, and the chord it answers to unless it has been moved. */
export const SHORTCUTS: ReadonlyArray<{
  action: ShortcutAction;
  chord: string;
  description: string;
}> = [
  { action: 'toggle-help', chord: 'Ctrl+Shift+/', description: 'this help panel' },
  { action: 'new-terminal', chord: 'Ctrl+Shift+T', description: 'new local terminal in the current workspace' },
  { action: 'new-workspace', chord: 'Ctrl+Shift+N', description: 'new workspace' },
  { action: 'toggle-overview', chord: 'Ctrl+Shift+O', description: 'session overview' },
  { action: 'toggle-layout', chord: 'Ctrl+Shift+L', description: 'fold to a single pane, or back to the last split' },
  { action: 'toggle-sidebar', chord: 'Ctrl+Shift+B', description: 'toggle sessions sidebar' },
  { action: 'history-palette', chord: 'Ctrl+Shift+R', description: 'ranked command history palette' },
  { action: 'ask-ai', chord: 'Ctrl+Shift+A', description: 'ask the AI endpoint for a command' },
  { action: 'toggle-settings', chord: 'Ctrl+Shift+,', description: 'settings' }
];

/** Chords that are not the app's to give away. */
export const RESERVED: ReadonlyArray<{ chord: string; description: string; reason: string }> = [
  { chord: 'Ctrl+Shift+C', description: 'copy the terminal selection', reason: 'the terminal uses it to copy' },
  { chord: 'Ctrl+Shift+V', description: 'paste into the focused terminal', reason: 'the terminal uses it to paste' }
];

/**
 * Chords other software takes first, so the help panel can say so.
 *
 * A user whose shortcut does nothing has no way to tell a bug here from a
 * conflict out there, and these are the ones worth naming: they were either
 * reported on this project or are documented global hotkeys. The panel checks
 * them against the bindings in force, so it can point at the one that is
 * actually affected rather than listing trivia.
 */
export const FOREIGN_CLAIMS: ReadonlyArray<{ chord: string; owner: string }> = [
  { chord: 'Ctrl+Shift+O', owner: 'Teams, for its camera toggle while a call is running' },
  { chord: 'Ctrl+Shift+M', owner: 'Teams, for mute while a call is running' }
];

/**
 * How a key is written in a chord.
 *
 * Codes rather than characters, so a chord means the same physical key on every
 * layout, and only keys that can be read back: a chord nobody can recognise in
 * a tooltip is not one worth storing.
 */
const KEY_NAMES: ReadonlyArray<[RegExp, (match: RegExpExecArray) => string]> = [
  [/^Key([A-Z])$/, (match) => match[1]],
  [/^Digit([0-9])$/, (match) => match[1]],
  [/^F([1-9]|1[0-2])$/, (match) => `F${match[1]}`],
  [/^Comma$/, () => ','],
  [/^Period$/, () => '.'],
  [/^Slash$/, () => '/'],
  [/^Semicolon$/, () => ';'],
  [/^Quote$/, () => "'"],
  [/^BracketLeft$/, () => '['],
  [/^BracketRight$/, () => ']'],
  [/^Minus$/, () => '-'],
  [/^Equal$/, () => '='],
  [/^Backquote$/, () => '`'],
  [/^(Space|Enter|Tab|Backspace|Home|End|PageUp|PageDown|Insert|Delete)$/, (match) => match[1]],
  [/^Arrow(Up|Down|Left|Right)$/, (match) => match[1]]
];

function keyName(code: string): string | null {
  for (const [pattern, name] of KEY_NAMES) {
    const match = pattern.exec(code);
    if (match) return name(match);
  }
  return null;
}

/**
 * The chord a keypress is, or null for one that cannot be a chord here.
 *
 * Ctrl is required, and Shift or Alt with it. A bare Ctrl+key belongs to the
 * shell — Ctrl+C interrupts, Ctrl+R searches history, Ctrl+A reaches screen and
 * tmux — and this application does not get to take those from every pane, local
 * and remote, for the sake of its own chrome.
 */
export function chordFromEvent(event: ShortcutEvent): string | null {
  const ctrl = event.ctrlKey || event.metaKey;
  const alt = Boolean(event.altKey);
  if (!ctrl || !(event.shiftKey || alt)) return null;
  const key = keyName(event.code);
  if (!key) return null;
  return ['Ctrl', ...(alt ? ['Alt'] : []), ...(event.shiftKey ? ['Shift'] : []), key].join('+');
}

/** The key names a chord may end in — the ones an event can produce. */
const KEY_PATTERN = /^([A-Z]|[0-9]|F([1-9]|1[0-2])|[,./;'\[\]\-=`]|Space|Enter|Tab|Backspace|Home|End|PageUp|PageDown|Insert|Delete|Up|Down|Left|Right)$/;

/**
 * Is this text a chord this module could match?
 *
 * Checked rather than trusted because a chord arrives from stored settings,
 * where it may have been hand-edited into something no keypress can produce.
 */
export function isChord(chord: unknown): boolean {
  if (typeof chord !== 'string' || !chord || chord.length > 40) return false;
  const parts = chord.split('+');
  const key = parts.pop() as string;
  if (!KEY_PATTERN.test(key)) return false;
  if (parts[0] !== 'Ctrl') return false;
  const modifiers = parts.slice(1).join('+');
  // Ctrl alone is the shell's; Alt then Shift is the order chordFromEvent writes.
  return modifiers === 'Shift' || modifiers === 'Alt' || modifiers === 'Alt+Shift';
}

export type ShortcutOverrides = Partial<Record<ShortcutAction, string>>;

export type Bindings = {
  /** The chord each action answers to, defaults included. */
  chords: Readonly<Record<ShortcutAction, string>>;
  /** Overrides that could not be honoured, with the reason, for Settings to show. */
  rejected: ReadonlyArray<{ action: ShortcutAction; chord: string; reason: string }>;
};

const DEFAULT_CHORDS = Object.freeze(
  Object.fromEntries(SHORTCUTS.map((entry) => [entry.action, entry.chord]))
) as Record<ShortcutAction, string>;

/** The workspace positions, which are a family rather than a single binding. */
const WORKSPACE_CHORD = /^Ctrl\+Shift\+([1-9])$/;

/**
 * Why a chord cannot be used for an action, or null when it can.
 *
 * The same rules the capture field in Settings applies and the stored file is
 * checked against, so a hand-edited setting cannot do what the interface would
 * refuse.
 */
export function chordProblem(
  chord: string,
  action: ShortcutAction,
  taken: Readonly<Record<string, ShortcutAction>> = {}
): string | null {
  if (!isChord(chord)) {
    return 'A shortcut needs Ctrl and at least one of Shift or Alt, so a shell keeps Ctrl+C and Ctrl+R for itself.';
  }
  const reserved = RESERVED.find((entry) => entry.chord === chord);
  if (reserved) return `${chord} is reserved: ${reserved.reason}.`;
  if (WORKSPACE_CHORD.test(chord)) return `${chord} switches to a workspace by position.`;
  const owner = taken[chord];
  if (owner && owner !== action) {
    const name = SHORTCUTS.find((entry) => entry.action === owner)?.description ?? owner;
    return `${chord} is already ${name}.`;
  }
  return null;
}

/**
 * The bindings in force, given what was stored.
 *
 * An override that cannot be honoured leaves the default in place and is
 * reported rather than dropped in silence: a shortcut quietly returning to a
 * chord the user had moved would look like the app forgetting.
 */
export function resolveBindings(overrides: ShortcutOverrides | undefined = {}): Bindings {
  const chords: Record<ShortcutAction, string> = { ...DEFAULT_CHORDS };
  const rejected: Array<{ action: ShortcutAction; chord: string; reason: string }> = [];

  // Two passes, because a user swapping two shortcuts is asking for something
  // reasonable: taken one at a time, the first move would collide with the
  // second action's old chord and be refused. So the shape of each override is
  // checked first, then collisions are judged against where everything ends up.
  const wanted = new Map<ShortcutAction, string>();
  for (const { action } of SHORTCUTS) {
    const chord = overrides?.[action];
    if (typeof chord !== 'string' || !chord || chord === chords[action]) continue;
    const problem = chordProblem(chord, action);
    if (problem) {
      rejected.push({ action, chord, reason: problem });
      continue;
    }
    wanted.set(action, chord);
  }

  for (const [action, chord] of wanted) chords[action] = chord;

  // Anything doubled up now is a genuine clash. The action declared later gives
  // way, so the outcome does not depend on how the stored file was written.
  for (const { action } of [...SHORTCUTS].reverse()) {
    const chord = chords[action];
    const clash = (Object.entries(chords) as Array<[ShortcutAction, string]>)
      .find(([other, otherChord]) => other !== action && otherChord === chord);
    if (!clash) continue;
    // Only an override gives way; a binding the user never touched stays put.
    if (!wanted.has(action)) continue;
    chords[action] = DEFAULT_CHORDS[action];
    const name = SHORTCUTS.find((entry) => entry.action === clash[0])?.description ?? clash[0];
    rejected.push({ action, chord, reason: `${chord} is already ${name}.` });
  }

  return { chords, rejected };
}

export const DEFAULT_BINDINGS: Bindings = resolveBindings();

/** The chord to show for an action, wherever the interface names one. */
export function chordFor(action: ShortcutAction, bindings: Bindings = DEFAULT_BINDINGS): string {
  return bindings.chords[action] ?? DEFAULT_CHORDS[action];
}

/** Whether this action is on a chord other than the one it shipped with. */
export function isMoved(action: ShortcutAction, bindings: Bindings = DEFAULT_BINDINGS): boolean {
  return chordFor(action, bindings) !== DEFAULT_CHORDS[action];
}

/**
 * The binding a keypress asks for, or null for one this app does not claim.
 *
 * Returning null rather than acting is the point: a chord with no binding must
 * reach the shell untouched.
 */
export function matchShortcut(event: ShortcutEvent, bindings: Bindings = DEFAULT_BINDINGS): Shortcut | null {
  if (event.inTextField) return null;
  const chord = chordFromEvent(event);
  if (!chord) return null;

  const workspace = WORKSPACE_CHORD.exec(chord);
  if (workspace) return { action: 'switch-workspace', position: Number(workspace[1]) };

  for (const [action, bound] of Object.entries(bindings.chords) as Array<[ShortcutAction, string]>) {
    if (bound === chord) return { action };
  }
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
  'help',
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

/**
 * The keyboard reference the help panel shows.
 *
 * Built from the bindings in force rather than written out again, so the panel
 * describes the keys this copy of the app answers to, including ones the user
 * has moved. The two families that are not single bindings are added here: the
 * clipboard pair, which the terminal handles rather than matchShortcut, and the
 * workspace positions, which are one row rather than nine.
 */
export function shortcutRows(bindings: Bindings = DEFAULT_BINDINGS): Array<{ chord: string; description: string }> {
  return [
    ...SHORTCUTS.map(({ action, description }) => ({ chord: chordFor(action, bindings), description })),
    { chord: 'Ctrl+Shift+1 … 9', description: 'switch to a workspace by position' },
    ...RESERVED.map((entry) => ({ chord: entry.chord, description: entry.description })),
    { chord: 'Esc', description: 'close whatever is open, or cancel a recording' }
  ];
}
