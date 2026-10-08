import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/renderer/settings';
import {
  DEFAULT_THEME,
  THEMES,
  THEME_DEFINITIONS,
  isLightTheme,
  terminalPalette,
  toggledTheme
} from '../src/renderer/themes';

const css = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return '';
  return css.slice(start, css.indexOf('}', start));
}

const tokens = [...block(':root').matchAll(/--([a-z0-9-]+):/g)].map((match) => match[1]);

describe('theme list', () => {
  it('has unique ids, labels and a default that exists', () => {
    expect(new Set(THEMES).size).toBe(THEMES.length);
    expect(new Set(THEME_DEFINITIONS.map((entry) => entry.label)).size).toBe(THEMES.length);
    expect(THEMES).toContain(DEFAULT_THEME);
  });

  it('keeps the two ids that were stored before the list existed', () => {
    expect(THEMES).toContain('dark');
    expect(THEMES).toContain('light');
    expect(isLightTheme('light')).toBe(true);
    expect(isLightTheme('dark')).toBe(false);
  });

  it('has a terminal palette for every theme', () => {
    for (const theme of THEMES) {
      const palette = terminalPalette(theme);
      for (const colour of [palette.background, palette.foreground, palette.cursor]) {
        expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

describe('theme styles', () => {
  it('defines the tokens on :root', () => {
    expect(tokens.length).toBeGreaterThan(20);
  });

  it('gives every dark theme except the default a block that sets every token', () => {
    for (const theme of THEME_DEFINITIONS) {
      if (theme.kind !== 'dark' || theme.id === DEFAULT_THEME) continue;
      const body = block(`:root[data-theme='${theme.id}']`);
      expect(body, theme.id).not.toBe('');
      for (const token of tokens) expect(body, `${theme.id} --${token}`).toContain(`--${token}:`);
    }
  });

  it('paints the terminal in the same colour as the pane behind it', () => {
    for (const theme of THEME_DEFINITIONS) {
      if (theme.kind !== 'dark') continue;
      const body = theme.id === DEFAULT_THEME ? block(':root') : block(`:root[data-theme='${theme.id}']`);
      const surface = /--surface-0:\s*(#[0-9a-f]{6})/i.exec(body)?.[1];
      expect(theme.terminal.background.toLowerCase(), theme.id).toBe(surface?.toLowerCase());
    }
  });
});

describe('toggledTheme', () => {
  it('goes to light from any dark theme', () => {
    expect(toggledTheme('dracula', 'dracula')).toBe('light');
    expect(toggledTheme('dark', 'dark')).toBe('light');
  });

  it('returns to the last dark theme from light', () => {
    expect(toggledTheme('light', 'nord')).toBe('nord');
    expect(toggledTheme('light', 'light')).toBe(DEFAULT_THEME);
  });
});

describe('stored themes', () => {
  it('accepts every theme id and rejects an unknown one', () => {
    for (const theme of THEMES) expect(parseSettings({ appearance: { theme } }).appearance.theme).toBe(theme);
    expect(parseSettings({ appearance: { theme: 'neon' } }).appearance.theme).toBe(DEFAULT_THEME);
  });
});
