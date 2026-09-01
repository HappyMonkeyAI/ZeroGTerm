import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DISMISS_ORDER,
  SHORTCUTS,
  matchShortcut,
  topDismissTarget,
  type DismissTarget,
  type ShortcutEvent
} from '../src/renderer/shortcuts';

function press(overrides: Partial<ShortcutEvent> & { key: string }): ShortcutEvent {
  return { code: `Key${overrides.key.toUpperCase()}`, ctrlKey: true, metaKey: false, shiftKey: true, ...overrides };
}

/** The event a chord like `Ctrl+Shift+O` produces, as a browser reports it. */
function chordEvent(chord: string): ShortcutEvent {
  const last = chord.slice(chord.lastIndexOf('+') + 1);
  if (last === ',') {
    // Shift turns the comma into `<`, so only the code still names the key.
    return { key: '<', code: 'Comma', ctrlKey: true, metaKey: false, shiftKey: true };
  }
  return press({ key: last.toLowerCase() });
}

describe('matchShortcut', () => {
  it('answers to every chord in the registry', () => {
    for (const { chord, action } of SHORTCUTS) {
      expect(matchShortcut(chordEvent(chord)), chord).toEqual({ action });
    }
  });

  it('claims nothing without both Ctrl and Shift', () => {
    // The whole bargain with the shell: it keeps Ctrl+C, Ctrl+R, Ctrl+L and
    // Ctrl+A, so interrupt, reverse search, clear and the screen/tmux prefix all
    // still work in every pane.
    for (const key of ['c', 'r', 'l', 'a', 'o', 'n', 't', 'b']) {
      expect(matchShortcut(press({ key, shiftKey: false })), `Ctrl+${key}`).toBeNull();
      expect(matchShortcut(press({ key, ctrlKey: false })), `Shift+${key}`).toBeNull();
      expect(matchShortcut(press({ key, ctrlKey: false, shiftKey: false })), key).toBeNull();
    }
  });

  it('accepts Cmd in place of Ctrl', () => {
    expect(matchShortcut(press({ key: 'o', ctrlKey: false, metaKey: true }))).toEqual({ action: 'toggle-overview' });
  });

  it('leaves the clipboard chords to the terminal', () => {
    // Ctrl+Shift+C and V are xterm's, handled in terminal-clipboard.ts. Claiming
    // either here would take copy and paste away from every pane.
    expect(matchShortcut(press({ key: 'c' }))).toBeNull();
    expect(matchShortcut(press({ key: 'v' }))).toBeNull();
  });

  it('stays out of the app’s own text fields', () => {
    // Typing a workspace name that contains an `n` must not open a dialog.
    expect(matchShortcut(press({ key: 'n', inTextField: true }))).toBeNull();
    expect(matchShortcut(press({ key: 'n' }))).toEqual({ action: 'new-workspace' });
  });

  it('reads a workspace position from the code, not the character', () => {
    // Shift+1 reports as `!`, so the digit only survives in `code`.
    expect(matchShortcut({ key: '!', code: 'Digit1', ctrlKey: true, metaKey: false, shiftKey: true }))
      .toEqual({ action: 'switch-workspace', position: 1 });
    expect(matchShortcut({ key: '(', code: 'Digit9', ctrlKey: true, metaKey: false, shiftKey: true }))
      .toEqual({ action: 'switch-workspace', position: 9 });
  });

  it('has no tenth workspace', () => {
    // There is no Ctrl+Shift+0: the tabs are numbered from one, and a zero would
    // have to mean either the first or the tenth.
    expect(matchShortcut({ key: ')', code: 'Digit0', ctrlKey: true, metaKey: false, shiftKey: true })).toBeNull();
  });

  it('returns null for a chord nothing is bound to', () => {
    // Which is what lets it through to the pane: an unclaimed chord is not this
    // app's business.
    for (const key of ['x', 'y', 'z', 'q', 'j']) {
      expect(matchShortcut(press({ key })), key).toBeNull();
    }
  });

  it('binds each action once', () => {
    const actions = SHORTCUTS.map((entry) => entry.action);
    expect(new Set(actions).size).toBe(actions.length);
    const chords = SHORTCUTS.map((entry) => entry.chord);
    expect(new Set(chords).size).toBe(chords.length);
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
    // A dialog opened from Settings is above it, and Escape has to shut the one
    // the user is looking at rather than the one underneath.
    expect(topDismissTarget({ settings: true, modal: true, history: true })).toBe('settings');
    expect(topDismissTarget({ modal: true, palette: true })).toBe('modal');
    expect(topDismissTarget({ transfer: true, settings: true })).toBe('transfer');
  });

  it('does not close a pane’s directory browser', () => {
    // It is part of the pane, not an overlay, and Escape has to keep reaching
    // the shell for `vi` to be usable.
    expect(DISMISS_ORDER).not.toContain('browser' as DismissTarget);
  });
});

/**
 * The check that would have caught the dead Ctrl+Shift+A: a chord named in a
 * tooltip, the status bar, or the README, with nothing bound to it.
 *
 * Reading the sources from a test is unusual, and it is the only way to state
 * this property at all — the alternative is what happened, which is a promise
 * sitting in a tooltip for two releases.
 */
describe('what the app claims matches what it binds', () => {
  const CHORD = /Ctrl\+Shift\+([A-Za-z],?|,)/g;
  /** xterm's, handled in terminal-clipboard.ts rather than by matchShortcut. */
  const CLIPBOARD = ['Ctrl+Shift+C', 'Ctrl+Shift+V'];

  function sourceFiles(): string[] {
    const dir = join(process.cwd(), 'src', 'renderer');
    return readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && name !== 'shortcuts.ts')
      .map((name) => join(dir, name));
  }

  function chordsIn(text: string): string[] {
    // A trailing comma in prose ("Ctrl+Shift+R, never Ctrl+R") is punctuation,
    // not the settings chord, unless the comma is the whole key.
    return [...text.matchAll(CHORD)].map((match) => `Ctrl+Shift+${match[1] === ',' ? ',' : match[1].replace(/,$/, '')}`);
  }

  const known = new Set([...SHORTCUTS.map((entry) => entry.chord), ...CLIPBOARD]);

  it('every chord the UI shows is bound', () => {
    const claimed = new Map<string, string>();
    for (const file of sourceFiles()) {
      for (const chord of chordsIn(readFileSync(file, 'utf8'))) {
        if (!known.has(chord.toUpperCase()) && !known.has(chord)) claimed.set(chord, file);
      }
    }
    expect([...claimed.entries()].map(([chord, file]) => `${chord} in ${file}`)).toEqual([]);
  });

  it('every binding is documented in the README', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Terminal shortcuts'));
    const documented = new Set(chordsIn(section.slice(0, section.indexOf('\n## ', 3))));
    for (const { chord } of SHORTCUTS) {
      expect(documented.has(chord), `${chord} is not in the README's shortcut list`).toBe(true);
    }
  });

  it('the README’s list names no chord that does nothing', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const section = readme.slice(readme.indexOf('## Terminal shortcuts'));
    const listed = chordsIn(section.slice(0, section.indexOf('\n## ', 3)));
    for (const chord of listed) {
      expect(known.has(chord), `the README lists ${chord}, which nothing binds`).toBe(true);
    }
  });
});
