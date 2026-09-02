import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BINDINGS,
  DISMISS_ORDER,
  RESERVED,
  SHORTCUTS,
  chordFor,
  chordFromEvent,
  chordProblem,
  isChord,
  isMoved,
  matchShortcut,
  resolveBindings,
  shortcutRows,
  topDismissTarget,
  type DismissTarget,
  type ShortcutEvent
} from '../src/renderer/shortcuts';

function press(overrides: Partial<ShortcutEvent> & { code: string }): ShortcutEvent {
  return { key: 'x', ctrlKey: true, metaKey: false, shiftKey: true, ...overrides };
}

/** The event a chord's text describes, as a browser would report it. */
function eventFor(chord: string): ShortcutEvent {
  const parts = chord.split('+');
  const key = parts.pop() as string;
  const codes: Record<string, string> = {
    ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote',
    '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', '`': 'Backquote'
  };
  const code = codes[key]
    ?? (/^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : key);
  return {
    // Deliberately not the character the chord names: under Shift the key
    // reports something else entirely, which is the reason chords are written
    // in terms of the physical key.
    key: '?',
    code,
    ctrlKey: true,
    metaKey: false,
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt')
  };
}

describe('chordFromEvent', () => {
  it('writes a chord in one order, whatever order the keys were held', () => {
    expect(chordFromEvent(press({ code: 'KeyT' }))).toBe('Ctrl+Shift+T');
    expect(chordFromEvent(press({ code: 'KeyT', shiftKey: false, altKey: true }))).toBe('Ctrl+Alt+T');
    expect(chordFromEvent(press({ code: 'KeyT', altKey: true }))).toBe('Ctrl+Alt+Shift+T');
  });

  it('names the physical key, not the character Shift makes of it', () => {
    expect(chordFromEvent(press({ code: 'Comma', key: '<' }))).toBe('Ctrl+Shift+,');
    expect(chordFromEvent(press({ code: 'Slash', key: '?' }))).toBe('Ctrl+Shift+/');
    expect(chordFromEvent(press({ code: 'Digit1', key: '!' }))).toBe('Ctrl+Shift+1');
  });

  it('accepts Cmd in place of Ctrl', () => {
    expect(chordFromEvent(press({ code: 'KeyT', ctrlKey: false, metaKey: true }))).toBe('Ctrl+Shift+T');
  });

  it('refuses anything the shell should keep', () => {
    // Ctrl alone, Shift alone, or neither: Ctrl+C interrupts, Ctrl+R searches
    // history, Ctrl+A reaches screen. None of those are this app's to take.
    expect(chordFromEvent(press({ code: 'KeyC', shiftKey: false }))).toBeNull();
    expect(chordFromEvent(press({ code: 'KeyR', shiftKey: false }))).toBeNull();
    expect(chordFromEvent(press({ code: 'KeyT', ctrlKey: false }))).toBeNull();
    expect(chordFromEvent(press({ code: 'KeyT', ctrlKey: false, shiftKey: false }))).toBeNull();
  });

  it('refuses a key it could not write down', () => {
    // A modifier on its own, or something exotic: a chord nobody can recognise
    // in a tooltip is not one to store.
    expect(chordFromEvent(press({ code: 'ShiftLeft' }))).toBeNull();
    expect(chordFromEvent(press({ code: 'ControlLeft' }))).toBeNull();
    expect(chordFromEvent(press({ code: 'MediaPlayPause' }))).toBeNull();
  });
});

describe('isChord', () => {
  it('accepts the families a keypress can produce', () => {
    for (const chord of ['Ctrl+Shift+T', 'Ctrl+Alt+T', 'Ctrl+Alt+Shift+T', 'Ctrl+Shift+,', 'Ctrl+Shift+F5', 'Ctrl+Alt+Up']) {
      expect(isChord(chord), chord).toBe(true);
    }
  });

  it('refuses text no keypress could produce', () => {
    for (const chord of ['', 'T', 'Ctrl+T', 'Shift+T', 'Alt+Shift+T', 'Ctrl+Shift', 'Ctrl+Shift+Meta+T',
      'Ctrl+Shift+F13', 'Ctrl+Shift+Escape', 'ctrl+shift+t', 'Ctrl+Shift+T ', 'x'.repeat(60)]) {
      expect(isChord(chord), chord).toBe(false);
    }
    expect(isChord(undefined)).toBe(false);
    expect(isChord(7)).toBe(false);
  });
});

describe('matchShortcut', () => {
  it('answers to every default chord', () => {
    for (const { chord, action } of SHORTCUTS) {
      expect(matchShortcut(eventFor(chord)), chord).toEqual({ action });
    }
  });

  it('answers to a chord the user has moved it to, and no longer to the old one', () => {
    // The reported problem: Ctrl+Shift+T was already taken on Windows 11.
    const bindings = resolveBindings({ 'new-terminal': 'Ctrl+Alt+T' });
    expect(matchShortcut(eventFor('Ctrl+Alt+T'), bindings)).toEqual({ action: 'new-terminal' });
    expect(matchShortcut(eventFor('Ctrl+Shift+T'), bindings)).toBeNull();
    // And the chord it left behind stays free rather than falling through to
    // something else.
    expect(matchShortcut(eventFor('Ctrl+Shift+T'), bindings)).not.toEqual({ action: 'new-workspace' });
  });

  it('leaves the other bindings where they were', () => {
    const bindings = resolveBindings({ 'new-terminal': 'Ctrl+Alt+T' });
    expect(matchShortcut(eventFor('Ctrl+Shift+O'), bindings)).toEqual({ action: 'toggle-overview' });
    expect(matchShortcut(eventFor('Ctrl+Shift+,'), bindings)).toEqual({ action: 'toggle-settings' });
  });

  it('keeps the workspace positions whatever else has moved', () => {
    const bindings = resolveBindings({ 'toggle-overview': 'Ctrl+Alt+O' });
    expect(matchShortcut(eventFor('Ctrl+Shift+1'), bindings)).toEqual({ action: 'switch-workspace', position: 1 });
    expect(matchShortcut(eventFor('Ctrl+Shift+9'), bindings)).toEqual({ action: 'switch-workspace', position: 9 });
    // No tenth: the tabs are numbered from one, and a zero would have to mean
    // either the first or the tenth.
    expect(matchShortcut(eventFor('Ctrl+Shift+0'), bindings)).toBeNull();
  });

  it('leaves the clipboard chords to the terminal', () => {
    for (const { chord } of RESERVED) {
      expect(matchShortcut(eventFor(chord)), chord).toBeNull();
    }
  });

  it('stays out of the app’s own text fields', () => {
    expect(matchShortcut({ ...eventFor('Ctrl+Shift+N'), inTextField: true })).toBeNull();
    expect(matchShortcut(eventFor('Ctrl+Shift+N'))).toEqual({ action: 'new-workspace' });
  });

  it('returns null for a chord nothing is bound to', () => {
    for (const chord of ['Ctrl+Shift+X', 'Ctrl+Alt+Q', 'Ctrl+Shift+F7']) {
      expect(matchShortcut(eventFor(chord)), chord).toBeNull();
    }
  });

  it('binds each action and each chord once', () => {
    const actions = SHORTCUTS.map((entry) => entry.action);
    const chords = SHORTCUTS.map((entry) => entry.chord);
    expect(new Set(actions).size).toBe(actions.length);
    expect(new Set(chords).size).toBe(chords.length);
  });
});

describe('chordProblem', () => {
  const taken = Object.fromEntries(SHORTCUTS.map((entry) => [entry.chord, entry.action]));

  it('accepts a free chord', () => {
    expect(chordProblem('Ctrl+Alt+T', 'new-terminal', taken)).toBeNull();
    expect(chordProblem('Ctrl+Shift+F9', 'new-terminal', taken)).toBeNull();
  });

  it('accepts the chord an action already has', () => {
    expect(chordProblem('Ctrl+Shift+T', 'new-terminal', taken)).toBeNull();
  });

  it('explains a chord that is another action’s', () => {
    expect(chordProblem('Ctrl+Shift+O', 'new-terminal', taken)).toContain('session overview');
  });

  it('refuses the clipboard pair with the reason', () => {
    expect(chordProblem('Ctrl+Shift+C', 'new-terminal', taken)).toContain('copy');
    expect(chordProblem('Ctrl+Shift+V', 'new-terminal', taken)).toContain('paste');
  });

  it('refuses a workspace position', () => {
    expect(chordProblem('Ctrl+Shift+3', 'new-terminal', taken)).toContain('workspace');
  });

  it('explains what a shortcut needs', () => {
    // The message a capture field shows when someone presses Ctrl+T, which is
    // the shell's.
    expect(chordProblem('Ctrl+T', 'new-terminal', taken)).toContain('Ctrl and at least one of Shift or Alt');
    expect(chordProblem('', 'new-terminal', taken)).toContain('Ctrl and at least one of Shift or Alt');
  });
});

describe('resolveBindings', () => {
  it('is the defaults when nothing has been changed', () => {
    expect(resolveBindings().chords).toEqual(DEFAULT_BINDINGS.chords);
    expect(resolveBindings({}).rejected).toEqual([]);
    expect(resolveBindings(undefined).rejected).toEqual([]);
  });

  it('honours a usable override', () => {
    const bindings = resolveBindings({ 'new-terminal': 'Ctrl+Alt+T' });
    expect(chordFor('new-terminal', bindings)).toBe('Ctrl+Alt+T');
    expect(isMoved('new-terminal', bindings)).toBe(true);
    expect(isMoved('new-workspace', bindings)).toBe(false);
    expect(bindings.rejected).toEqual([]);
  });

  it('swaps two actions’ chords when asked for both', () => {
    const bindings = resolveBindings({ 'new-terminal': 'Ctrl+Shift+O', 'toggle-overview': 'Ctrl+Shift+T' });
    expect(chordFor('new-terminal', bindings)).toBe('Ctrl+Shift+O');
    expect(chordFor('toggle-overview', bindings)).toBe('Ctrl+Shift+T');
    expect(bindings.rejected).toEqual([]);
  });

  it('keeps the default and says why when an override cannot be honoured', () => {
    // Dropped in silence, a shortcut returning to a chord the user had moved
    // would look like the app forgetting.
    const bindings = resolveBindings({
      'new-terminal': 'Ctrl+Shift+C',
      'toggle-overview': 'nonsense',
      'toggle-sidebar': 'Ctrl+Shift+2'
    });
    expect(chordFor('new-terminal', bindings)).toBe('Ctrl+Shift+T');
    expect(chordFor('toggle-overview', bindings)).toBe('Ctrl+Shift+O');
    expect(chordFor('toggle-sidebar', bindings)).toBe('Ctrl+Shift+B');
    expect(bindings.rejected.map((entry) => entry.action)).toEqual(['new-terminal', 'toggle-overview', 'toggle-sidebar']);
    expect(bindings.rejected[0].reason).toContain('copy');
  });

  it('refuses an override that collides with a binding that has not moved', () => {
    const bindings = resolveBindings({ 'new-terminal': 'Ctrl+Shift+B' });
    expect(chordFor('new-terminal', bindings)).toBe('Ctrl+Shift+T');
    expect(bindings.rejected[0].reason).toContain('sidebar');
  });

  it('ignores an unknown action in the stored file', () => {
    const bindings = resolveBindings({ 'do-a-barrel-roll': 'Ctrl+Shift+Q' } as never);
    expect(bindings.chords).toEqual(DEFAULT_BINDINGS.chords);
    expect(bindings.rejected).toEqual([]);
  });
});

describe('topDismissTarget', () => {
  it('closes nothing when nothing is open', () => {
    expect(topDismissTarget({})).toBeNull();
    expect(topDismissTarget({ overview: false })).toBeNull();
  });

  it('closes the one thing that is open, wherever it sits in the order', () => {
    for (const target of DISMISS_ORDER) {
      expect(topDismissTarget({ [target]: true }), target).toBe(target);
    }
  });

  it('closes the outermost when several are open', () => {
    expect(topDismissTarget({ help: true, settings: true, modal: true })).toBe('help');
    expect(topDismissTarget({ settings: true, modal: true, history: true })).toBe('settings');
    expect(topDismissTarget({ modal: true, palette: true })).toBe('modal');
  });

  it('does not close a pane’s directory browser', () => {
    // It is part of the pane, not an overlay, and Escape has to keep reaching
    // the shell for `vi` to be usable.
    expect(DISMISS_ORDER).not.toContain('browser' as DismissTarget);
  });
});

describe('the help panel’s keyboard reference', () => {
  it('lists every binding, so the panel cannot describe a chord that does nothing', () => {
    const listed = new Set(shortcutRows().map((row) => row.chord));
    for (const { chord } of SHORTCUTS) {
      expect(listed.has(chord), `${chord} is bound but not in the help panel`).toBe(true);
    }
  });

  it('shows a moved chord rather than the one it shipped with', () => {
    const rows = shortcutRows(resolveBindings({ 'new-terminal': 'Ctrl+Alt+T' }));
    const chords = rows.map((row) => row.chord);
    expect(chords).toContain('Ctrl+Alt+T');
    expect(chords).not.toContain('Ctrl+Shift+T');
  });

  it('includes the families that are not single bindings', () => {
    const chords = shortcutRows().map((row) => row.chord);
    expect(chords).toContain('Ctrl+Shift+1 … 9');
    expect(chords).toContain('Ctrl+Shift+C');
    expect(chords).toContain('Ctrl+Shift+V');
    expect(chords).toContain('Esc');
  });

  it('describes each row exactly once', () => {
    const rows = shortcutRows();
    for (const row of rows) expect(row.description.length, row.chord).toBeGreaterThan(3);
    expect(new Set(rows.map((row) => row.chord)).size).toBe(rows.length);
  });
});

/**
 * The check that would have caught the dead Ctrl+Shift+A: a chord named in a
 * tooltip, the status bar, or the README, with nothing bound to it.
 *
 * It has a second job now that bindings can be moved. A chord written into a
 * tooltip is a lie as soon as the user rebinds that action, so no source file
 * outside this module may contain one at all — they have to come from
 * chordFor(), which reads the bindings in force.
 */
describe('what the app claims matches what it binds', () => {
  const CHORD = /Ctrl\+(?:Alt\+Shift\+|Alt\+|Shift\+)([A-Za-z0-9]|,|\/|F\d{1,2})(?![\w+])/g;
  const OWN_FILE = 'shortcuts.ts';

  function sourceFiles(): string[] {
    const dir = join(process.cwd(), 'src', 'renderer');
    return readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && name !== OWN_FILE)
      .map((name) => join(dir, name));
  }

  const allowed = new Set(RESERVED.map((entry) => entry.chord));

  it('writes no chord into the interface, because a rebound one would then be wrong', () => {
    const found: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(CHORD)) {
        const chord = match[0];
        // The clipboard pair and the workspace positions cannot be moved, so
        // naming either of them cannot become wrong.
        if (allowed.has(chord)) continue;
        if (/^Ctrl\+Shift\+[1-9]$/.test(chord)) continue;
        // Ctrl+Shift by itself, in prose about the keyboard-layout switch.
        if (!/\+[A-Za-z0-9,/]$|F\d{1,2}$/.test(chord)) continue;
        found.push(`${chord} in ${file.split(/[\\/]/).pop()}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('documents every default chord in the README', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Terminal shortcuts'));
    const list = section.slice(0, section.indexOf('\n## ', 3));
    for (const { chord } of SHORTCUTS) {
      expect(list, `${chord} is not in the README's shortcut list`).toContain(chord);
    }
  });

  it('lists no chord in the README that nothing binds', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Terminal shortcuts'));
    const list = section.slice(0, section.indexOf('\n## ', 3));
    const known = new Set([...SHORTCUTS.map((entry) => entry.chord), ...allowed]);
    for (const match of list.matchAll(CHORD)) {
      const chord = match[0];
      if (!/\+[A-Za-z0-9,/]$|F\d{1,2}$/.test(chord)) continue;
      // The workspace positions are written as a range.
      if (/^Ctrl\+Shift\+[1-9]$/.test(chord)) continue;
      expect(known.has(chord), `the README lists ${chord}, which nothing binds`).toBe(true);
    }
  });
});
