import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  LEGACY_THEME_KEY,
  SETTINGS_KEY,
  fontStack,
  loadSettings,
  parseSettings,
  resetSection,
  saveSettings,
  updateSection,
  type SettingsStorage
} from '../src/renderer/settings';

function fakeStorage(initial: Record<string, string> = {}) {
  const state: Record<string, string> = { ...initial };
  const storage: SettingsStorage & { state: Record<string, string> } = {
    state,
    getItem: (key) => (key in state ? state[key] : null),
    setItem: (key, value) => { state[key] = value; }
  };
  return storage;
}

describe('parseSettings', () => {
  it('returns the defaults for missing or non-object input', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid stored values', () => {
    const parsed = parseSettings({
      appearance: { theme: 'light', font: 'jetbrains', fontSize: 16, lineHeight: 1.4, letterSpacing: 0.5 },
      terminal: { scrollback: 5000, cursorStyle: 'bar', cursorBlink: false, copyOnSelect: false }
    });
    expect(parsed.appearance).toEqual({ theme: 'light', font: 'jetbrains', fontSize: 16, lineHeight: 1.4, letterSpacing: 0.5 });
    expect(parsed.terminal).toEqual({ scrollback: 5000, cursorStyle: 'bar', cursorBlink: false, copyOnSelect: false });
  });

  it('keeps the good fields of a partly invalid object', () => {
    // One bad value must not reset the user's whole setup.
    const parsed = parseSettings({
      appearance: { theme: 'light', fontSize: 'huge' },
      terminal: { cursorStyle: 'diamond' }
    });
    expect(parsed.appearance.theme).toBe('light');
    expect(parsed.appearance.fontSize).toBe(DEFAULT_SETTINGS.appearance.fontSize);
    expect(parsed.terminal.cursorStyle).toBe(DEFAULT_SETTINGS.terminal.cursorStyle);
  });

  it('clamps numbers a hand-edited file could put out of range', () => {
    const parsed = parseSettings({
      appearance: { fontSize: 900, lineHeight: 0.1, letterSpacing: -50 },
      terminal: { scrollback: 10_000_000 },
      speech: { maxUtteranceSeconds: 5000, silenceThreshold: 12 }
    });
    expect(parsed.appearance.fontSize).toBe(32);
    expect(parsed.appearance.lineHeight).toBe(1);
    expect(parsed.appearance.letterSpacing).toBe(-2);
    expect(parsed.terminal.scrollback).toBe(200000);
    expect(parsed.speech.maxUtteranceSeconds).toBe(120);
    expect(parsed.speech.silenceThreshold).toBe(0.05);
  });

  it('rejects NaN and infinity rather than passing them to xterm', () => {
    const parsed = parseSettings({ appearance: { fontSize: Number.NaN, lineHeight: Number.POSITIVE_INFINITY } });
    expect(parsed.appearance.fontSize).toBe(DEFAULT_SETTINGS.appearance.fontSize);
    expect(parsed.appearance.lineHeight).toBe(DEFAULT_SETTINGS.appearance.lineHeight);
  });

  it('rounds the settings that must be whole numbers', () => {
    const parsed = parseSettings({ appearance: { fontSize: 14.7 }, terminal: { scrollback: 999.6 }, speech: { maxUtteranceSeconds: 20.4 } });
    expect(parsed.appearance.fontSize).toBe(15);
    expect(parsed.terminal.scrollback).toBe(1000);
    expect(parsed.speech.maxUtteranceSeconds).toBe(20);
  });

  it('falls back to a known model when the stored id is not in the catalogue', () => {
    expect(parseSettings({ speech: { model: 'unslothai/Qwen3-ASR-0.6B-GGUF' } }).speech.model)
      .toBe(DEFAULT_SETTINGS.speech.model);
  });

  it('drops a language when the model is English-only, since whisper rejects it', () => {
    expect(parseSettings({ speech: { model: 'onnx-community/whisper-tiny.en', language: 'fr' } }).speech.language).toBe('auto');
    expect(parseSettings({ speech: { model: 'onnx-community/whisper-small', language: 'fr' } }).speech.language).toBe('fr');
  });

  it('keeps a language for the server engine, whose model choice is its own', () => {
    // The built-in model field is irrelevant when a server does the work, so an
    // English-only value there must not silence the language sent to the server.
    const parsed = parseSettings({
      speech: { engine: 'server', model: 'onnx-community/whisper-tiny.en', language: 'fr' }
    });
    expect(parsed.speech.language).toBe('fr');
  });

  it('rejects a language code that is not offered', () => {
    expect(parseSettings({ speech: { model: 'onnx-community/whisper-small', language: 'kl' } }).speech.language).toBe('auto');
  });

  it('adopts the theme chosen before settings existed', () => {
    expect(parseSettings(undefined, 'light').appearance.theme).toBe('light');
    // An explicit stored theme wins over the legacy key.
    expect(parseSettings({ appearance: { theme: 'dark' } }, 'light').appearance.theme).toBe('dark');
    expect(parseSettings(undefined, 'nonsense').appearance.theme).toBe('dark');
  });
});

describe('loadSettings', () => {
  it('reads and validates what was stored', () => {
    const storage = fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ appearance: { theme: 'light', fontSize: 18 } }) });
    const settings = loadSettings(storage);
    expect(settings.appearance.theme).toBe('light');
    expect(settings.appearance.fontSize).toBe(18);
  });

  it('survives corrupt JSON', () => {
    expect(loadSettings(fakeStorage({ [SETTINGS_KEY]: '{not json' }))).toEqual(DEFAULT_SETTINGS);
  });

  it('migrates a lone legacy theme key', () => {
    expect(loadSettings(fakeStorage({ [LEGACY_THEME_KEY]: 'light' })).appearance.theme).toBe('light');
  });

  it('works without storage at all', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    const throwing: SettingsStorage = {
      getItem: () => { throw new Error('storage disabled'); },
      setItem: () => { throw new Error('storage disabled'); }
    };
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(throwing, DEFAULT_SETTINGS)).not.toThrow();
  });
});

describe('saveSettings', () => {
  it('round-trips through storage', () => {
    const storage = fakeStorage();
    const settings = updateSection(DEFAULT_SETTINGS, 'appearance', { theme: 'light', fontSize: 15 });
    saveSettings(storage, settings);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('keeps the legacy theme key in step for a downgrade', () => {
    const storage = fakeStorage();
    saveSettings(storage, updateSection(DEFAULT_SETTINGS, 'appearance', { theme: 'light' }));
    expect(storage.state[LEGACY_THEME_KEY]).toBe('light');
  });
});

describe('updateSection', () => {
  it('patches one section and leaves the rest alone', () => {
    const next = updateSection(DEFAULT_SETTINGS, 'terminal', { scrollback: 2000 });
    expect(next.terminal.scrollback).toBe(2000);
    expect(next.terminal.cursorStyle).toBe(DEFAULT_SETTINGS.terminal.cursorStyle);
    expect(next.appearance).toEqual(DEFAULT_SETTINGS.appearance);
  });

  it('validates the patch, so a control cannot store an out-of-range value', () => {
    expect(updateSection(DEFAULT_SETTINGS, 'appearance', { fontSize: 400 }).appearance.fontSize).toBe(32);
  });

  it('normalises a language that the newly chosen model cannot use', () => {
    const multilingual = updateSection(DEFAULT_SETTINGS, 'speech', { model: 'onnx-community/whisper-small', language: 'de' });
    expect(multilingual.speech.language).toBe('de');
    const englishOnly = updateSection(multilingual, 'speech', { model: 'onnx-community/whisper-base.en' });
    expect(englishOnly.speech.language).toBe('auto');
  });
});

describe('resetSection', () => {
  it('restores one section only', () => {
    const changed = updateSection(
      updateSection(DEFAULT_SETTINGS, 'appearance', { fontSize: 20 }),
      'speech',
      { maxUtteranceSeconds: 90 }
    );
    const reset = resetSection(changed, 'speech');
    expect(reset.speech).toEqual(DEFAULT_SETTINGS.speech);
    expect(reset.appearance.fontSize).toBe(20);
  });
});

describe('fontStack', () => {
  it('always ends in a generic monospace fallback', () => {
    for (const choice of ['system', 'jetbrains', 'cascadia', 'consolas', 'fira', 'menlo'] as const) {
      expect(fontStack(choice).endsWith('monospace')).toBe(true);
    }
  });
});
