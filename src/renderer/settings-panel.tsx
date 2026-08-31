// The settings panel. Presentational: it renders the current settings, reports
// edits through onChange, and shows whatever speech-test state the app hands
// it. Recording and transcription stay in App, which already owns the
// microphone and the speech client, so the panel cannot start a second
// recorder behind the app's back.

import React, { useState } from 'react';
import type { ShellBackend } from '../shared/types';
import {
  DEFAULT_SETTINGS,
  FONT_CHOICES,
  SETTING_LIMITS,
  fontStack,
  resolveDefaultBackend,
  speechFieldVisibility,
  type CursorStyle,
  type FontChoice,
  type Layout,
  type LocalBackend,
  type Settings,
  type SettingsSection,
  type SpeechDevice,
  type SpeechEngine,
  type Theme,
  type VoiceInsert
} from './settings';
import {
  SPEECH_LANGUAGES,
  SPEECH_MODELS,
  SPEECH_PRECISIONS,
  describeDownload,
  type SpeechPrecision,
  type SpeechTask
} from './speech-models';
import type { BackdropDismissHandlers } from './backdrop-dismiss';
import { isLoopbackEndpoint, isSupportedEndpoint, sendsKeyInClear } from './speech-server';
import { INTEGRATION_SHELLS, integrationFile, integrationSnippet, type IntegrationShell } from './shell-integration';

export type SettingsPage = SettingsSection;

/** What the app reports about a run of the speech test. */
export type SpeechTestState = {
  status: 'idle' | 'recording' | 'transcribing';
  /** Progress or fallback notices from the engine, e.g. model download percent. */
  message?: string | null;
  transcript?: string | null;
  elapsedMs?: number | null;
  /** Recording level, so a silent microphone is visible as a cause. */
  level?: number | null;
  error?: string | null;
};

/**
 * What the app knows about the speech server key.
 *
 * The key itself is deliberately absent: it lives encrypted in the main
 * process, so the panel can say whether one is saved but never shows it.
 * `sessionOnly` means this system could not encrypt it and it is being held in
 * memory until the app closes.
 */
export type SpeechKeyState = {
  status: 'idle' | 'saving';
  stored: boolean;
  encryptionAvailable: boolean;
  sessionOnly: boolean;
  notice?: string | null;
  error?: string | null;
};

export type SettingsPanelProps = {
  settings: Settings;
  onChange: <K extends SettingsSection>(section: K, patch: Partial<Settings[K]>) => void;
  onReset: (section: SettingsSection) => void;
  onClose: () => void;
  backdrop: BackdropDismissHandlers;
  /** Shells this machine actually has, so the default cannot be one that is missing. */
  backends: ShellBackend[];
  wslDistributions: string[];
  speechTest: SpeechTestState;
  onSpeechTest: () => void;
  speechKey: SpeechKeyState;
  onSpeechKeySave: (key: string) => void;
  onSpeechKeyClear: () => void;
  /** How the command history is doing, for the section that switches it on. */
  commandHistory: CommandHistoryState;
  onCopySnippet: (snippet: string) => void;
  onClearCommandHistory: () => void;
};

/**
 * What the panel knows about command recording.
 *
 * `panesReporting` answers the question someone actually has after pasting a
 * snippet — did it work — without asking them to run something and guess.
 */
export type CommandHistoryState = {
  entries: number;
  panesReporting: number;
  panesOpen: number;
};

const PAGES: Array<{ id: SettingsPage; label: string; hint: string; blurb: string }> = [
  { id: 'appearance', label: 'Appearance', hint: 'Theme, font', blurb: 'How the workspace and terminal text look.' },
  { id: 'terminal', label: 'Terminal', hint: 'Scrollback, cursor', blurb: 'Behaviour of every terminal pane.' },
  { id: 'sessions', label: 'Sessions', hint: 'Defaults, layout', blurb: 'What new terminals and new windows start as.' },
  { id: 'ai', label: 'AI & voice', hint: 'Approval, insert', blurb: 'How AI suggestions and transcripts reach a terminal.' },
  { id: 'speech', label: 'Speech recognition', hint: 'Engine, model', blurb: 'Which recogniser runs, and how it is tuned.' }
];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="settings-field">
      <span className="settings-field-label">{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/**
 * What to say under the speech server URL field.
 *
 * Any http(s) host is allowed, so the hint carries the part the user cannot see
 * from the URL alone: whether the recording is about to leave this machine.
 */
function speechServerUrlHint(url: string): string {
  const shape = 'OpenAI-compatible: POST multipart audio to /v1/audio/transcriptions.';
  if (!isSupportedEndpoint(url)) return `Any http:// or https:// address. ${shape}`;
  if (isLoopbackEndpoint(url)) return `On this machine. ${shape}`;
  return `Off this machine — recorded audio is sent to this host. ${shape}`;
}

/**
 * The key field: type a key, save it, or clear the saved one.
 *
 * The input is local state rather than a setting, because the key is never
 * part of the settings object — there is nothing to render it back from, and
 * that is the point. It empties on save, and the field below says what is
 * stored.
 */
function ServerApiKeyField({
  state,
  url,
  onSave,
  onClear
}: {
  state: SpeechKeyState;
  url: string;
  onSave: (key: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState('');
  const saving = state.status === 'saving';
  const trimmed = draft.trim();

  const hint = !state.encryptionAvailable
    ? 'This system has no secret store, so a key can only be held until the app closes.'
    : sendsKeyInClear(url)
      ? 'Sent as a Bearer token. This endpoint is plain http to another host, so the key travels in the clear.'
      : 'Sent as a Bearer token. Stored encrypted by this system, never in the settings file.';

  return (
    <Field label="Server API key" hint={hint}>
      <div className="settings-key-row">
        <input
          type="password"
          value={draft}
          placeholder={state.stored || state.sessionOnly ? '••••••••  (a key is set)' : 'Leave empty if the server needs none'}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !trimmed || saving) return;
            event.preventDefault();
            onSave(trimmed);
            setDraft('');
          }}
        />
        <button
          type="button"
          disabled={!trimmed || saving}
          onClick={() => {
            onSave(trimmed);
            setDraft('');
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {state.stored || state.sessionOnly ? (
          <button type="button" disabled={saving} onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      {state.error ? <small className="settings-key-error">{state.error}</small> : null}
      {!state.error && state.notice ? <small className="settings-key-notice">{state.notice}</small> : null}
    </Field>
  );
}

/**
 * Command recording, and the snippet that makes it work.
 *
 * The toggle and the snippet sit together because neither is much use alone:
 * turning recording on without shell integration records nothing, and pasting
 * the snippet without turning recording on records nothing either. Saying so is
 * cheaper than letting someone discover it.
 */
function CommandHistorySection({
  enabled,
  state,
  onToggle,
  onCopySnippet,
  onClear
}: {
  enabled: boolean;
  state: CommandHistoryState;
  onToggle: (enabled: boolean) => void;
  onCopySnippet: (snippet: string) => void;
  onClear: () => void;
}) {
  const [shell, setShell] = useState<IntegrationShell>('bash');
  const snippet = integrationSnippet(shell);

  return (
    <>
      <Toggle
        label="Remember commands for the history palette"
        hint={
          enabled
            ? 'Commands you run are stored on this machine, with their directory and exit status, so Ctrl+Shift+R can rank them. Anything that looks like it carries a secret is refused rather than stored.'
            : 'Off. Nothing about what you type is written anywhere. Turning this on stores commands on this machine so the history palette has something to search.'
        }
        checked={enabled}
        onChange={onToggle}
      />

      {enabled ? (
        <>
          <div className="settings-note">
            {state.panesOpen === 0
              ? 'No panes open, so nothing is reporting yet.'
              : state.panesReporting === 0
                ? `None of your ${state.panesOpen} open pane${state.panesOpen === 1 ? '' : 's'} is reporting prompt marks. Add the snippet below to that shell — including on a remote host, where it has to be installed there.`
                : `${state.panesReporting} of ${state.panesOpen} open pane${state.panesOpen === 1 ? '' : 's'} reporting prompt marks. ${state.entries} command${state.entries === 1 ? '' : 's'} remembered.`}
          </div>

          <Field
            label="Shell integration"
            hint={`Paste this into ${integrationFile(shell)} on whichever machine the shell runs on. It emits the standard OSC 133 marks — if you already have shell integration from VS Code, kitty or an oh-my-zsh plugin, you need none of this.`}
          >
            <div className="settings-key-row">
              <select value={shell} onChange={(event) => setShell(event.target.value as IntegrationShell)}>
                {INTEGRATION_SHELLS.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.label}</option>
                ))}
              </select>
              <button type="button" onClick={() => onCopySnippet(snippet)}>Copy snippet</button>
            </div>
          </Field>
          <pre className="settings-snippet">{snippet}</pre>

          <div className="settings-test">
            <button type="button" onClick={onClear}>Forget all remembered commands</button>
            <small className="settings-hint">Removes the stored history and the file it lives in.</small>
          </div>
        </>
      ) : null}
    </>
  );
}

function SelectField<T extends string>({
  label,
  hint,
  value,
  options,
  onChange
}: {
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </Field>
  );
}

function RangeField({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <span className="settings-range">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label={label}
        />
        <output>{format(value)}</output>
      </span>
    </Field>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <b>{label}</b>
        {hint ? <small>{hint}</small> : null}
      </span>
    </label>
  );
}

function EngineChoice({
  value,
  onChange
}: {
  value: SpeechEngine;
  onChange: (engine: SpeechEngine) => void;
}) {
  const options: Array<{ id: SpeechEngine; title: string; detail: string }> = [
    {
      id: 'builtin',
      title: 'Built-in',
      detail: 'Whisper ONNX in this app, downloaded once and cached. No other software needed.'
    },
    {
      id: 'server',
      title: 'Server',
      detail: 'Post audio to a transcription server — on this machine, on the LAN, or hosted — the way to use a GGUF model such as Qwen3-ASR through llama.cpp, LM Studio or Unsloth Studio.'
    }
  ];
  return (
    <div className="settings-engines" role="radiogroup" aria-label="Speech engine">
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          role="radio"
          aria-checked={value === option.id}
          className={`settings-engine ${value === option.id ? 'active' : ''}`}
          onClick={() => onChange(option.id)}
        >
          <b>{option.title}</b>
          <small>{option.detail}</small>
        </button>
      ))}
    </div>
  );
}

function SpeechTest({ state, onRun }: { state: SpeechTestState; onRun: () => void }) {
  const busy = state.status !== 'idle';
  const label = state.status === 'recording' ? 'Stop and transcribe' : state.status === 'transcribing' ? 'Transcribing…' : 'Test recognition';
  return (
    <div className="settings-test">
      <div className="settings-test-head">
        <div>
          <b>Try it</b>
          <small>Records a phrase and transcribes it here, without typing into a terminal.</small>
        </div>
        <button
          type="button"
          className={state.status === 'recording' ? 'settings-test-button recording' : 'settings-test-button'}
          onClick={onRun}
          disabled={state.status === 'transcribing'}
        >
          {label}
        </button>
      </div>
      {state.message ? <p className="settings-test-status">{state.message}</p> : null}
      {state.error ? <p className="settings-test-error">{state.error}</p> : null}
      {state.transcript !== null && state.transcript !== undefined ? (
        <output className="settings-test-transcript">{state.transcript || '(nothing transcribed)'}</output>
      ) : null}
      {!busy && (state.elapsedMs != null || state.level != null) ? (
        <p className="settings-test-metrics">
          {state.elapsedMs != null ? `${(state.elapsedMs / 1000).toFixed(1)}s` : null}
          {state.elapsedMs != null && state.level != null ? ' · ' : null}
          {state.level != null ? `level ${state.level.toFixed(4)} RMS` : null}
        </p>
      ) : null}
    </div>
  );
}

export function SettingsPanel({
  settings,
  onChange,
  onReset,
  onClose,
  backdrop,
  backends,
  wslDistributions,
  speechTest,
  onSpeechTest,
  speechKey,
  onSpeechKeySave,
  onSpeechKeyClear,
  commandHistory,
  onCopySnippet,
  onClearCommandHistory
}: SettingsPanelProps) {
  const [page, setPage] = useState<SettingsPage>('appearance');
  const active = PAGES.find((entry) => entry.id === page) ?? PAGES[0];
  const visible = speechFieldVisibility(settings.speech);

  // Only offer shells that were discovered; a default of zsh on a machine
  // without zsh would fail at the point of opening a terminal, not here.
  const backendOptions: Array<{ value: LocalBackend; label: string }> = backends.length
    ? backends.map((backend) => ({ value: backend.backend as LocalBackend, label: backend.label }))
    : [{ value: settings.sessions.defaultBackend, label: settings.sessions.defaultBackend }];

  return (
    <div className="modal-layer settings-layer" role="presentation" {...backdrop}>
      <section className="settings-card" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="modal-head">
          <div>
            <span className="eyebrow">SETTINGS</span>
            <h2>{active.label}</h2>
          </div>
          <button type="button" className="close-button" onClick={onClose}>Esc</button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings pages">
            {PAGES.map((entry) => (
              <button
                type="button"
                key={entry.id}
                className={`settings-nav-item ${entry.id === page ? 'active' : ''}`}
                aria-current={entry.id === page}
                onClick={() => setPage(entry.id)}
              >
                <b>{entry.label}</b>
                <small>{entry.hint}</small>
              </button>
            ))}
          </nav>

          <div className="settings-page">
            <p className="settings-blurb">{active.blurb}</p>

            {page === 'appearance' && (
              <>
                <SelectField<Theme>
                  label="Theme"
                  value={settings.appearance.theme}
                  options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
                  onChange={(theme) => onChange('appearance', { theme })}
                />
                <SelectField<FontChoice>
                  label="Terminal font"
                  hint="Falls back to another monospace face when the font is not installed."
                  value={settings.appearance.font}
                  options={FONT_CHOICES}
                  onChange={(font) => onChange('appearance', { font })}
                />
                <RangeField
                  label="Font size"
                  value={settings.appearance.fontSize}
                  min={SETTING_LIMITS.fontSize.min}
                  max={SETTING_LIMITS.fontSize.max}
                  step={1}
                  format={(value) => `${value} px`}
                  onChange={(fontSize) => onChange('appearance', { fontSize })}
                />
                <RangeField
                  label="Line height"
                  value={settings.appearance.lineHeight}
                  min={SETTING_LIMITS.lineHeight.min}
                  max={SETTING_LIMITS.lineHeight.max}
                  step={0.05}
                  format={(value) => value.toFixed(2)}
                  onChange={(lineHeight) => onChange('appearance', { lineHeight })}
                />
                <RangeField
                  label="Letter spacing"
                  value={settings.appearance.letterSpacing}
                  min={SETTING_LIMITS.letterSpacing.min}
                  max={SETTING_LIMITS.letterSpacing.max}
                  step={0.1}
                  format={(value) => `${value.toFixed(1)} px`}
                  onChange={(letterSpacing) => onChange('appearance', { letterSpacing })}
                />
                <div
                  className="settings-preview"
                  style={{
                    fontFamily: fontStack(settings.appearance.font),
                    fontSize: `${settings.appearance.fontSize}px`,
                    lineHeight: settings.appearance.lineHeight,
                    letterSpacing: `${settings.appearance.letterSpacing}px`
                  }}
                >
                  <span>user@host:~$ git status --short</span>
                  <span> M src/renderer/settings.ts</span>
                </div>
              </>
            )}

            {page === 'terminal' && (
              <>
                <RangeField
                  label="Scrollback"
                  hint="Lines kept per pane. Larger scrollback costs memory in every open pane."
                  value={settings.terminal.scrollback}
                  min={SETTING_LIMITS.scrollback.min}
                  max={50000}
                  step={200}
                  format={(value) => `${value.toLocaleString()} lines`}
                  onChange={(scrollback) => onChange('terminal', { scrollback })}
                />
                <SelectField<CursorStyle>
                  label="Cursor"
                  value={settings.terminal.cursorStyle}
                  options={[
                    { value: 'block', label: 'Block' },
                    { value: 'underline', label: 'Underline' },
                    { value: 'bar', label: 'Bar' }
                  ]}
                  onChange={(cursorStyle) => onChange('terminal', { cursorStyle })}
                />
                <Toggle
                  label="Blink the cursor"
                  checked={settings.terminal.cursorBlink}
                  onChange={(cursorBlink) => onChange('terminal', { cursorBlink })}
                />
                <Toggle
                  label="Copy on selection"
                  hint="Selecting text with the mouse puts it on the clipboard. Ctrl+Shift+C copies regardless."
                  checked={settings.terminal.copyOnSelect}
                  onChange={(copyOnSelect) => onChange('terminal', { copyOnSelect })}
                />
              </>
            )}

            {page === 'sessions' && (
              <>
                <SelectField<LocalBackend>
                  label="Default shell"
                  hint="Pre-selected when opening a new local terminal."
                  // Shows what a new terminal would actually start as: a stored
                  // default this machine does not have falls back to the
                  // platform's preferred shell rather than displaying a lie.
                  value={resolveDefaultBackend(settings.sessions.defaultBackend, backends)}
                  options={backendOptions}
                  onChange={(defaultBackend) => onChange('sessions', { defaultBackend })}
                />
                <Field label="Default WSL distribution" hint="Used when the default shell is WSL.">
                  <input
                    list="settings-wsl-distributions"
                    value={settings.sessions.defaultWslDistribution}
                    placeholder="Ubuntu"
                    onChange={(event) => onChange('sessions', { defaultWslDistribution: event.target.value })}
                  />
                  <datalist id="settings-wsl-distributions">
                    {wslDistributions.map((distribution) => (
                      <option key={distribution} value={distribution} />
                    ))}
                  </datalist>
                </Field>
                <SelectField<Layout>
                  label="Layout at startup"
                  value={settings.sessions.defaultLayout}
                  options={[
                    { value: 'stack', label: 'Single pane' },
                    { value: 'split-v', label: 'Split vertically' },
                    { value: 'split-h', label: 'Split horizontally' },
                    { value: 'grid', label: 'Grid of four' }
                  ]}
                  onChange={(defaultLayout) => onChange('sessions', { defaultLayout })}
                />
                <Toggle
                  label="Start with the sidebar collapsed"
                  checked={settings.sessions.startSidebarCollapsed}
                  onChange={(startSidebarCollapsed) => onChange('sessions', { startSidebarCollapsed })}
                />
              </>
            )}

            {page === 'ai' && (
              <>
                <Toggle
                  label="Ask before running an AI suggestion"
                  hint="Off means a suggested command is sent to the terminal as soon as it arrives."
                  checked={settings.ai.requireApproval}
                  onChange={(requireApproval) => onChange('ai', { requireApproval })}
                />
                <SelectField<VoiceInsert>
                  label="Voice transcripts"
                  hint="Neither option presses Enter for you."
                  value={settings.ai.voiceInsert}
                  options={[
                    { value: 'type', label: 'Type into the terminal' },
                    { value: 'review', label: 'Show for review first' }
                  ]}
                  onChange={(voiceInsert) => onChange('ai', { voiceInsert })}
                />
                <Field
                  label="Proceed phrase"
                  hint="What a pane's tick button sends. Unlike the options above, this one does press Enter — it is for telling an agent already waiting in the pane to carry on."
                >
                  <input
                    value={settings.ai.proceedPhrase}
                    placeholder={DEFAULT_SETTINGS.ai.proceedPhrase}
                    onChange={(event) => onChange('ai', { proceedPhrase: event.target.value })}
                  />
                </Field>

                <CommandHistorySection
                  enabled={settings.ai.recordCommands}
                  state={commandHistory}
                  onToggle={(recordCommands) => onChange('ai', { recordCommands })}
                  onCopySnippet={onCopySnippet}
                  onClear={onClearCommandHistory}
                />
              </>
            )}

            {page === 'speech' && (
              <>
                <EngineChoice value={settings.speech.engine} onChange={(engine) => onChange('speech', { engine })} />

                {visible.model ? (
                  <SelectField
                    label="Model"
                    hint={describeDownload(settings.speech.model, settings.speech.precision)}
                    value={settings.speech.model}
                    options={SPEECH_MODELS.map((model) => ({ value: model.id, label: model.label }))}
                    onChange={(model) => onChange('speech', { model })}
                  />
                ) : null}

                {visible.precision ? (
                  <SelectField<SpeechPrecision>
                    label="Precision"
                    hint={SPEECH_PRECISIONS.find((entry) => entry.value === settings.speech.precision)?.detail}
                    value={settings.speech.precision}
                    options={SPEECH_PRECISIONS.map((entry) => ({ value: entry.value, label: entry.label }))}
                    onChange={(precision) => onChange('speech', { precision })}
                  />
                ) : null}

                {visible.device ? (
                  <SelectField<SpeechDevice>
                    label="Compute"
                    hint="WebGPU is faster where it works; the app falls back to WASM when it does not."
                    value={settings.speech.device}
                    options={[
                      { value: 'wasm', label: 'CPU (WASM)' },
                      { value: 'webgpu', label: 'GPU (WebGPU)' }
                    ]}
                    onChange={(device) => onChange('speech', { device })}
                  />
                ) : null}

                {visible.language ? (
                  <SelectField
                    label="Language"
                    value={settings.speech.language}
                    options={SPEECH_LANGUAGES}
                    onChange={(language) => onChange('speech', { language })}
                  />
                ) : null}

                {visible.task ? (
                  <SelectField<SpeechTask>
                    label="Task"
                    hint="Translate produces English text from another language."
                    value={settings.speech.task}
                    options={[
                      { value: 'transcribe', label: 'Transcribe' },
                      { value: 'translate', label: 'Translate to English' }
                    ]}
                    onChange={(task) => onChange('speech', { task })}
                  />
                ) : null}

                {visible.server ? (
                  <>
                    <Field
                      label="Server URL"
                      hint={speechServerUrlHint(settings.speech.serverUrl)}
                    >
                      <input
                        value={settings.speech.serverUrl}
                        placeholder="http://127.0.0.1:8080/v1/audio/transcriptions"
                        onChange={(event) => onChange('speech', { serverUrl: event.target.value })}
                      />
                    </Field>
                    <Field label="Server model" hint="The model name the server expects, e.g. Qwen3-ASR-0.6B.">
                      <input
                        value={settings.speech.serverModel}
                        placeholder="Qwen3-ASR-0.6B"
                        onChange={(event) => onChange('speech', { serverModel: event.target.value })}
                      />
                    </Field>
                    <ServerApiKeyField
                      state={speechKey}
                      url={settings.speech.serverUrl}
                      onSave={onSpeechKeySave}
                      onClear={onSpeechKeyClear}
                    />
                  </>
                ) : null}

                <RangeField
                  label="Maximum utterance"
                  hint="Recording stops itself at this length so a stuck microphone cannot queue forever."
                  value={settings.speech.maxUtteranceSeconds}
                  min={SETTING_LIMITS.maxUtteranceSeconds.min}
                  max={SETTING_LIMITS.maxUtteranceSeconds.max}
                  step={5}
                  format={(value) => `${value} s`}
                  onChange={(maxUtteranceSeconds) => onChange('speech', { maxUtteranceSeconds })}
                />
                <RangeField
                  label="Silence threshold"
                  hint="Recordings quieter than this are discarded without transcribing. Raise it for a noisy room, lower it for a quiet microphone."
                  value={settings.speech.silenceThreshold}
                  min={SETTING_LIMITS.silenceThreshold.min}
                  max={SETTING_LIMITS.silenceThreshold.max}
                  step={0.0005}
                  format={(value) => value.toFixed(4)}
                  onChange={(silenceThreshold) => onChange('speech', { silenceThreshold })}
                />

                <SpeechTest state={speechTest} onRun={onSpeechTest} />
              </>
            )}

            <div className="settings-foot">
              <span className="settings-hint">Changes apply immediately and are remembered.</span>
              <button type="button" onClick={() => onReset(page)}>Reset {active.label.toLowerCase()}</button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
