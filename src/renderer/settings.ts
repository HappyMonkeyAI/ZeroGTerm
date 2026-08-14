// User settings: the schema, the defaults, and the reader that turns whatever
// is in storage into a value the rest of the app can trust.
//
// Everything here is renderer state, so it lives in localStorage next to the
// theme it replaces. Reading is synchronous, which is why the window can paint
// the stored theme and font on the first frame instead of flashing defaults.
//
// Stored settings are untrusted input: they may come from an older version, a
// newer version, or a hand-edited value. parseSettings therefore validates
// every field against the schema and falls back per field rather than throwing
// away the whole object — one bad number must not reset a user's whole setup.

import {
  DEFAULT_SPEECH_MODEL,
  SPEECH_LANGUAGES,
  SPEECH_MODELS,
  findSpeechModel,
  type SpeechPrecision,
  type SpeechTask
} from './speech-models';

export type Theme = 'dark' | 'light';
export type Layout = 'stack' | 'split-v' | 'split-h' | 'grid';
export type LocalBackend = 'bash' | 'zsh' | 'powershell' | 'wsl';
export type CursorStyle = 'block' | 'underline' | 'bar';
export type FontChoice = 'system' | 'jetbrains' | 'cascadia' | 'consolas' | 'fira' | 'menlo';
export type SpeechEngine = 'builtin' | 'server';
export type SpeechDevice = 'wasm' | 'webgpu';
/** Type the transcript straight into the pane, or show it for review first. */
export type VoiceInsert = 'type' | 'review';

export type AppearanceSettings = {
  theme: Theme;
  font: FontChoice;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
};

export type TerminalSettings = {
  scrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Copy the selection to the clipboard as soon as it is made. */
  copyOnSelect: boolean;
};

export type SessionSettings = {
  defaultBackend: LocalBackend;
  defaultWslDistribution: string;
  defaultLayout: Layout;
  startSidebarCollapsed: boolean;
};

export type AiSettings = {
  /** Show the approval dialog before an AI suggestion reaches a terminal. */
  requireApproval: boolean;
  voiceInsert: VoiceInsert;
};

export type SpeechSettings = {
  engine: SpeechEngine;
  model: string;
  precision: SpeechPrecision;
  device: SpeechDevice;
  /** 'auto' or a Whisper language code; ignored by English-only models. */
  language: string;
  task: SpeechTask;
  maxUtteranceSeconds: number;
  /** RMS below which a recording is treated as silence and never transcribed. */
  silenceThreshold: number;
  serverUrl: string;
  serverModel: string;
};

export type Settings = {
  appearance: AppearanceSettings;
  terminal: TerminalSettings;
  sessions: SessionSettings;
  ai: AiSettings;
  speech: SpeechSettings;
};

export type SettingsSection = keyof Settings;

export const SETTINGS_KEY = 'zerog-settings';
/** The single preference that predates this module. */
export const LEGACY_THEME_KEY = 'zerog-theme';

export const DEFAULT_SETTINGS: Settings = {
  appearance: {
    theme: 'dark',
    font: 'system',
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0
  },
  terminal: {
    scrollback: 10000,
    cursorStyle: 'block',
    cursorBlink: true,
    copyOnSelect: true
  },
  sessions: {
    defaultBackend: 'bash',
    defaultWslDistribution: '',
    defaultLayout: 'stack',
    startSidebarCollapsed: false
  },
  ai: {
    requireApproval: true,
    voiceInsert: 'type'
  },
  speech: {
    engine: 'builtin',
    model: DEFAULT_SPEECH_MODEL,
    precision: 'q8',
    device: 'wasm',
    language: 'auto',
    task: 'transcribe',
    maxUtteranceSeconds: 30,
    silenceThreshold: 0.004,
    serverUrl: 'http://127.0.0.1:8080/v1/audio/transcriptions',
    serverModel: 'Qwen3-ASR-0.6B'
  }
};

/**
 * Bounds for the numeric settings. The UI uses these for its slider ranges and
 * parseSettings clamps to them, so a hand-edited scrollback of 10 million
 * cannot make every pane allocate until the app dies.
 */
export const SETTING_LIMITS = {
  fontSize: { min: 8, max: 32 },
  lineHeight: { min: 1, max: 2 },
  letterSpacing: { min: -2, max: 4 },
  scrollback: { min: 200, max: 200000 },
  maxUtteranceSeconds: { min: 5, max: 120 },
  silenceThreshold: { min: 0.0005, max: 0.05 }
} as const;

/**
 * Terminal font stacks. Each choice keeps a fallback chain so a machine
 * without the named font still gets a monospace face rather than a
 * proportional one, which would break xterm's cell measurement.
 */
const FONT_STACKS: Record<FontChoice, string> = {
  system: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  jetbrains: '"JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", ui-monospace, Consolas, "Liberation Mono", monospace',
  consolas: 'Consolas, "Liberation Mono", ui-monospace, monospace',
  fira: '"Fira Code", "Fira Mono", ui-monospace, Consolas, "Liberation Mono", monospace',
  menlo: 'Menlo, Monaco, ui-monospace, Consolas, "Liberation Mono", monospace'
};

export const FONT_CHOICES: Array<{ value: FontChoice; label: string }> = [
  { value: 'system', label: 'System monospace' },
  { value: 'jetbrains', label: 'JetBrains Mono' },
  { value: 'cascadia', label: 'Cascadia Code' },
  { value: 'consolas', label: 'Consolas' },
  { value: 'fira', label: 'Fira Code' },
  { value: 'menlo', label: 'Menlo' }
];

export function fontStack(choice: FontChoice): string {
  return FONT_STACKS[choice] ?? FONT_STACKS.system;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickNumber(value: unknown, limits: { min: number; max: number }, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(limits.max, Math.max(limits.min, value));
}

function pickString(value: unknown, fallback: string, maxLength = 512): string {
  if (typeof value !== 'string') return fallback;
  return value.slice(0, maxLength);
}

const THEMES: readonly Theme[] = ['dark', 'light'];
const LAYOUTS: readonly Layout[] = ['stack', 'split-v', 'split-h', 'grid'];
const BACKENDS: readonly LocalBackend[] = ['bash', 'zsh', 'powershell', 'wsl'];
const CURSOR_STYLES: readonly CursorStyle[] = ['block', 'underline', 'bar'];
const FONTS: readonly FontChoice[] = ['system', 'jetbrains', 'cascadia', 'consolas', 'fira', 'menlo'];
const ENGINES: readonly SpeechEngine[] = ['builtin', 'server'];
const DEVICES: readonly SpeechDevice[] = ['wasm', 'webgpu'];
const PRECISIONS: readonly SpeechPrecision[] = ['q4', 'q8', 'fp16', 'fp32'];
const TASKS: readonly SpeechTask[] = ['transcribe', 'translate'];
const VOICE_INSERTS: readonly VoiceInsert[] = ['type', 'review'];

/**
 * Validate stored settings field by field, filling gaps from the defaults.
 *
 * `legacyTheme` carries the value of the old zerog-theme key so a user who
 * chose light mode before this module existed does not get dropped back to
 * dark on upgrade.
 */
export function parseSettings(raw: unknown, legacyTheme?: unknown): Settings {
  const source = isRecord(raw) ? raw : {};
  const appearance = isRecord(source.appearance) ? source.appearance : {};
  const terminal = isRecord(source.terminal) ? source.terminal : {};
  const sessions = isRecord(source.sessions) ? source.sessions : {};
  const ai = isRecord(source.ai) ? source.ai : {};
  const speech = isRecord(source.speech) ? source.speech : {};

  const defaultTheme = pickEnum(legacyTheme, THEMES, DEFAULT_SETTINGS.appearance.theme);
  const engine = pickEnum(speech.engine, ENGINES, DEFAULT_SETTINGS.speech.engine);
  const model = pickEnum(
    speech.model,
    SPEECH_MODELS.map((entry) => entry.id),
    DEFAULT_SETTINGS.speech.model
  );
  // A language on an English-only checkpoint is not merely unused: the pipeline
  // throws on it, so it is normalised away here instead of being remembered and
  // skipped at every call site. A server decides its own language handling, and
  // the built-in model choice must not silence a language sent to it.
  const language = engine === 'server' || findSpeechModel(model)?.multilingual
    ? pickEnum(speech.language, SPEECH_LANGUAGES.map((entry) => entry.value), DEFAULT_SETTINGS.speech.language)
    : 'auto';

  return {
    appearance: {
      theme: pickEnum(appearance.theme, THEMES, defaultTheme),
      font: pickEnum(appearance.font, FONTS, DEFAULT_SETTINGS.appearance.font),
      fontSize: Math.round(pickNumber(appearance.fontSize, SETTING_LIMITS.fontSize, DEFAULT_SETTINGS.appearance.fontSize)),
      lineHeight: pickNumber(appearance.lineHeight, SETTING_LIMITS.lineHeight, DEFAULT_SETTINGS.appearance.lineHeight),
      letterSpacing: pickNumber(appearance.letterSpacing, SETTING_LIMITS.letterSpacing, DEFAULT_SETTINGS.appearance.letterSpacing)
    },
    terminal: {
      scrollback: Math.round(pickNumber(terminal.scrollback, SETTING_LIMITS.scrollback, DEFAULT_SETTINGS.terminal.scrollback)),
      cursorStyle: pickEnum(terminal.cursorStyle, CURSOR_STYLES, DEFAULT_SETTINGS.terminal.cursorStyle),
      cursorBlink: pickBoolean(terminal.cursorBlink, DEFAULT_SETTINGS.terminal.cursorBlink),
      copyOnSelect: pickBoolean(terminal.copyOnSelect, DEFAULT_SETTINGS.terminal.copyOnSelect)
    },
    sessions: {
      defaultBackend: pickEnum(sessions.defaultBackend, BACKENDS, DEFAULT_SETTINGS.sessions.defaultBackend),
      defaultWslDistribution: pickString(sessions.defaultWslDistribution, DEFAULT_SETTINGS.sessions.defaultWslDistribution, 64),
      defaultLayout: pickEnum(sessions.defaultLayout, LAYOUTS, DEFAULT_SETTINGS.sessions.defaultLayout),
      startSidebarCollapsed: pickBoolean(sessions.startSidebarCollapsed, DEFAULT_SETTINGS.sessions.startSidebarCollapsed)
    },
    ai: {
      requireApproval: pickBoolean(ai.requireApproval, DEFAULT_SETTINGS.ai.requireApproval),
      voiceInsert: pickEnum(ai.voiceInsert, VOICE_INSERTS, DEFAULT_SETTINGS.ai.voiceInsert)
    },
    speech: {
      engine,
      model,
      precision: pickEnum(speech.precision, PRECISIONS, DEFAULT_SETTINGS.speech.precision),
      device: pickEnum(speech.device, DEVICES, DEFAULT_SETTINGS.speech.device),
      language,
      task: pickEnum(speech.task, TASKS, DEFAULT_SETTINGS.speech.task),
      maxUtteranceSeconds: Math.round(
        pickNumber(speech.maxUtteranceSeconds, SETTING_LIMITS.maxUtteranceSeconds, DEFAULT_SETTINGS.speech.maxUtteranceSeconds)
      ),
      silenceThreshold: pickNumber(speech.silenceThreshold, SETTING_LIMITS.silenceThreshold, DEFAULT_SETTINGS.speech.silenceThreshold),
      serverUrl: pickString(speech.serverUrl, DEFAULT_SETTINGS.speech.serverUrl, 512),
      serverModel: pickString(speech.serverModel, DEFAULT_SETTINGS.speech.serverModel, 128)
    }
  };
}

/** The storage surface used here; a plain object stands in for it in tests. */
export type SettingsStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

export function loadSettings(storage: SettingsStorage | null | undefined): Settings {
  if (!storage) return parseSettings(undefined);
  let stored: string | null = null;
  let legacyTheme: string | null = null;
  try {
    stored = storage.getItem(SETTINGS_KEY);
    legacyTheme = storage.getItem(LEGACY_THEME_KEY);
  } catch {
    // Storage can be unavailable (disabled, or over quota); defaults still work.
    return parseSettings(undefined);
  }
  if (!stored) return parseSettings(undefined, legacyTheme);
  try {
    return parseSettings(JSON.parse(stored), legacyTheme);
  } catch {
    // Corrupt JSON: fall back rather than leaving the app unusable.
    return parseSettings(undefined, legacyTheme);
  }
}

export function saveSettings(storage: SettingsStorage | null | undefined, settings: Settings): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    // Keep the legacy key in step so a downgrade still finds the theme.
    storage.setItem(LEGACY_THEME_KEY, settings.appearance.theme);
  } catch {
    // Settings still apply for this session when storage refuses the write.
  }
}

/**
 * Apply a patch to one section, re-validating the result.
 *
 * Going back through parseSettings means a control cannot write a value the
 * schema would reject — the clamp lives in one place instead of in every input
 * handler.
 */
export function updateSection<K extends SettingsSection>(
  settings: Settings,
  section: K,
  patch: Partial<Settings[K]>
): Settings {
  return parseSettings({ ...settings, [section]: { ...settings[section], ...patch } });
}

/**
 * Which speech controls apply to the current configuration.
 *
 * The two engines share almost nothing: model, precision and device belong to
 * the in-process pipeline, and URL and model name belong to the server. Showing
 * a control that has no effect invites the user to tune something that is being
 * ignored, so the panel asks here instead of guessing.
 */
export function speechFieldVisibility(speech: SpeechSettings): {
  model: boolean;
  precision: boolean;
  device: boolean;
  language: boolean;
  task: boolean;
  server: boolean;
} {
  const builtin = speech.engine === 'builtin';
  const multilingual = findSpeechModel(speech.model)?.multilingual ?? false;
  return {
    model: builtin,
    precision: builtin,
    device: builtin,
    // The server decides its own language handling, but it does accept a hint.
    language: builtin ? multilingual : true,
    task: builtin && multilingual,
    server: !builtin
  };
}

/** Restore one section to its defaults, leaving the others untouched. */
export function resetSection(settings: Settings, section: SettingsSection): Settings {
  return parseSettings({ ...settings, [section]: DEFAULT_SETTINGS[section] });
}
