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
/** Mirrors LocalShellBackend in shared/types; kept as a value list below too. */
export type LocalBackend = 'bash' | 'zsh' | 'fish' | 'sh' | 'powershell' | 'pwsh' | 'cmd' | 'wsl';

/**
 * How each backend is named in the UI when only the stored backend is known.
 *
 * Discovered backends arrive from the main process with their own labels; a
 * session that was created earlier carries only its backend, so the name has to
 * be reconstructible here. Windows PowerShell and PowerShell 7 are distinct
 * entries, and a session must not claim the one it did not run.
 */
export const BACKEND_LABELS: Record<LocalBackend, string> = {
  bash: 'bash',
  zsh: 'zsh',
  fish: 'fish',
  sh: 'sh',
  powershell: 'Windows PowerShell',
  pwsh: 'PowerShell 7',
  cmd: 'Command Prompt',
  wsl: 'WSL'
};

export function backendLabel(backend: string): string {
  return BACKEND_LABELS[backend as LocalBackend] ?? backend;
}
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
  /** Sidebar width in pixels, as the user last dragged it. */
  sidebarWidth: number;
  /**
   * Where the pane dividers sit, as the left/top share of the split. One pair
   * serves every layout: the vertical split uses the column value, the
   * horizontal split the row value, and the four-pane grid both.
   */
  splitColumnRatio: number;
  splitRowRatio: number;
};

export type AiSettings = {
  /**
   * Show the approval dialog before an AI suggestion reaches a terminal.
   *
   * Ignored, and shown as ignored, whenever terminal output was part of the
   * prompt: that is the combination where a remote host's output could pick a
   * command and have it run unseen. See canAutoRun in ai-suggest.ts.
   */
  requireApproval: boolean;
  voiceInsert: VoiceInsert;
  /**
   * What the pane's proceed button sends. Editable because agents differ in what
   * they respond to, and because a future version may offer a drafted reply here
   * instead of a fixed phrase.
   */
  proceedPhrase: string;
  /**
   * Record the commands run in each pane, for the history palette.
   *
   * Off by default, and the only setting in ZeroG that turns on storing what the
   * user typed. Nothing is recorded from a pane whose shell emits no OSC 133
   * marks, and nothing at all that command-redaction refuses.
   */
  recordCommands: boolean;
   /**
   * An OpenAI-compatible base URL, ending in the version segment.
   *
   * One field serves OpenAI, Ollama, LM Studio, llama.cpp, vLLM and OpenRouter,
   * because chat/completions is the one request shape they all implement.
   */
  baseUrl: string;
  model: string;
  /**
   * Send a bounded tail of the focused pane with the request.
   *
   * Off by default. On, the model can read the error actually being asked
   * about — and terminal content leaves the machine for whatever endpoint is
   * configured, which is why the panel says so and auto-run stops applying.
   */
  includeOutput: boolean;
  /** How much of that output, in characters. */
  outputChars: number;
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
    startSidebarCollapsed: false,
    sidebarWidth: 238,
    splitColumnRatio: 0.5,
    splitRowRatio: 0.5
  },
  ai: {
    requireApproval: true,
    voiceInsert: 'type',
    proceedPhrase: 'OK, proceed',
    recordCommands: false,
    // Ollama's default, because a local model is the case with no key to set up
    // and nothing leaving the machine.
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    includeOutput: false,
    outputChars: 2000
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
  // Enough for a stack trace, capped well below a context window. ai-protocol
  // enforces its own hard ceiling regardless of what is stored here.
  outputChars: { min: 200, max: 8000 },
  silenceThreshold: { min: 0.0005, max: 0.05 },
  // Wide enough for a session name and a path, narrow enough to leave a usable
  // terminal beside it. The drawer also carries a max-width in vw, so a small
  // window shrinks it below whatever is stored here.
  sidebarWidth: { min: 180, max: 520 },
  // A pane thinner than about a seventh of the workspace holds no usable
  // terminal, and dragging a divider off the edge is easy to do by accident.
  splitRatio: { min: 0.15, max: 0.85 }
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

/**
 * A phrase the app types into a terminal on the user's behalf.
 *
 * Control characters are replaced rather than kept. The caller supplies the
 * Enter, so a phrase carrying its own newline would send several lines — only
 * the last of which the user could see in the field they typed it into. Spaces
 * are left exactly as typed: this runs on every keystroke, and trimming here
 * would eat the space between words as the user types it.
 */
function pickPhrase(value: unknown, fallback: string, maxLength = 200): string {
  if (typeof value !== 'string') return fallback;
  return Array.from(value.slice(0, maxLength), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : character;
  }).join('');
}

/**
 * The phrase to send, given what is stored.
 *
 * A field the user has emptied would make the button do nothing, which reads as
 * a broken control rather than a deliberate setting — so an all-whitespace
 * phrase falls back to the default here, at the point of use, leaving the field
 * itself free to be empty while it is being retyped.
 */
export function resolveProceedPhrase(ai: AiSettings): string {
  return ai.proceedPhrase.trim() || DEFAULT_SETTINGS.ai.proceedPhrase;
}

const THEMES: readonly Theme[] = ['dark', 'light'];
const LAYOUTS: readonly Layout[] = ['stack', 'split-v', 'split-h', 'grid'];
const BACKENDS: readonly LocalBackend[] = ['bash', 'zsh', 'fish', 'sh', 'powershell', 'pwsh', 'cmd', 'wsl'];
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
      startSidebarCollapsed: pickBoolean(sessions.startSidebarCollapsed, DEFAULT_SETTINGS.sessions.startSidebarCollapsed),
      sidebarWidth: Math.round(pickNumber(sessions.sidebarWidth, SETTING_LIMITS.sidebarWidth, DEFAULT_SETTINGS.sessions.sidebarWidth)),
      splitColumnRatio: pickNumber(sessions.splitColumnRatio, SETTING_LIMITS.splitRatio, DEFAULT_SETTINGS.sessions.splitColumnRatio),
      splitRowRatio: pickNumber(sessions.splitRowRatio, SETTING_LIMITS.splitRatio, DEFAULT_SETTINGS.sessions.splitRowRatio)
    },
    ai: {
      requireApproval: pickBoolean(ai.requireApproval, DEFAULT_SETTINGS.ai.requireApproval),
      voiceInsert: pickEnum(ai.voiceInsert, VOICE_INSERTS, DEFAULT_SETTINGS.ai.voiceInsert),
      proceedPhrase: pickPhrase(ai.proceedPhrase, DEFAULT_SETTINGS.ai.proceedPhrase),
      recordCommands: pickBoolean(ai.recordCommands, DEFAULT_SETTINGS.ai.recordCommands),
      baseUrl: pickString(ai.baseUrl, DEFAULT_SETTINGS.ai.baseUrl, 512),
      model: pickString(ai.model, DEFAULT_SETTINGS.ai.model, 200),
      includeOutput: pickBoolean(ai.includeOutput, DEFAULT_SETTINGS.ai.includeOutput),
      outputChars: Math.round(pickNumber(ai.outputChars, SETTING_LIMITS.outputChars, DEFAULT_SETTINGS.ai.outputChars))
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
 * The backend a new terminal should start as.
 *
 * A stored default is only usable if this machine has that shell: settings
 * copied from a Linux box ask for bash, and a Windows machine may have no bash
 * at all. Falling back to the first discovered backend — the platform's
 * preferred shell — keeps the dialog from opening on a shell that cannot start.
 */
export function resolveDefaultBackend(
  stored: LocalBackend,
  available: ReadonlyArray<{ backend: string }>
): LocalBackend {
  if (available.some((shell) => shell.backend === stored)) return stored;
  const first = available[0]?.backend;
  return first && (BACKENDS as readonly string[]).includes(first) ? (first as LocalBackend) : stored;
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
