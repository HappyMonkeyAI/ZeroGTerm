import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import type { HistoryEntry, KnownConnection, SessionInfo, ShellBackend, TerminalApi } from '../shared/types';
import { VoiceRecorder, isMostlySilence, rootMeanSquare } from './voice';
import { looksLikeShellPrompt, normalizeHost } from './remote-screens';
import { attachTerminalClipboard } from './terminal-clipboard';
import { useBackdropDismiss } from './backdrop-dismiss';
import {
  backendLabel,
  fontStack,
  loadSettings,
  resetSection,
  resolveDefaultBackend,
  saveSettings,
  updateSection,
  type AppearanceSettings,
  type Layout,
  type LocalBackend,
  type Settings,
  type SettingsSection,
  type SettingsStorage,
  type TerminalSettings,
  type Theme
} from './settings';
import { SettingsPanel, type SpeechTestState } from './settings-panel';
import { SESSION_TABS, dialogCopy, isSessionDialogKind, nextSessionTab, type SessionDialogKind } from './session-dialog';
import { SpeechClient, type SpeechWorker } from './speech';

/** Settle once output has been quiet this long — the primary readiness signal. */
const PROMPT_QUIET_MS = 150;
/** Give up waiting and send anyway; matches the previous unconditional delay's role. */
const PROMPT_WAIT_CAP_MS = 3000;
/** Enough tail to hold a prompt spanning several chunks, without growing forever. */
const PROMPT_BUFFER_CHARS = 512;

type VoiceStatus = 'idle' | 'listening' | 'transcribing';

type ModalKind = 'workspace' | 'local' | 'ssh' | null;
type SidebarTab = 'terminals' | 'screens' | 'connections';

type Workspace = {
  id: string;
  name: string;
  sessionIds: string[];
};

const api = () => window.zerog;

/**
 * localStorage, or nothing when the renderer refuses to hand it over.
 *
 * Touching window.localStorage can itself throw when storage is disabled, so
 * settings has to be able to run without any store at all.
 */
function browserStorage(): SettingsStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function Icon({ name, className = '' }: { name: string; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: `icon-svg ${className}`.trim(),
    'aria-hidden': true as const
  };

  switch (name) {
    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case 'panel-left':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      );
    case 'panel-left-open':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16M6 9l2 3-2 3" />
        </svg>
      );
    case 'grid':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="7" height="7" rx="1" />
          <rect x="13" y="4" width="7" height="7" rx="1" />
          <rect x="4" y="13" width="7" height="7" rx="1" />
          <rect x="13" y="13" width="7" height="7" rx="1" />
        </svg>
      );
    case 'sessions':
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h10" />
        </svg>
      );
    case 'ssh':
      return (
        <svg {...common}>
          <path d="M7 17l5-5-5-5M12 17h7" />
        </svg>
      );
    case 'history':
      return (
        <svg {...common}>
          <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 4v4.5h4.5" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case 'spark':
      return (
        <svg {...common}>
          <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      );
    case 'sun':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      );
    case 'moon':
      return (
        <svg {...common}>
          <path d="M20.5 15.5A8.5 8.5 0 0 1 8.5 3.5 8.5 8.5 0 1 0 20.5 15.5z" />
        </svg>
      );
    case 'stack':
      return (
        <svg {...common}>
          <rect x="5" y="5" width="14" height="14" rx="1.5" />
        </svg>
      );
    case 'maximize':
      return (
        <svg {...common}>
          <path d="M8 4H4v4M16 4h4v4M4 16v4h4M20 16v4h-4" />
        </svg>
      );
    case 'restore':
      return (
        <svg {...common}>
          <path d="M8 8h12v12H8zM4 16V4h12" />
        </svg>
      );
    case 'chevron-left':
      return (
        <svg {...common}>
          <path d="M15 5l-7 7 7 7" />
        </svg>
      );
    case 'chevron-right':
      return (
        <svg {...common}>
          <path d="M9 5l7 7-7 7" />
        </svg>
      );
    case 'split-v':
      return (
        <svg {...common}>
          <rect x="4" y="5" width="7" height="14" rx="1" />
          <rect x="13" y="5" width="7" height="14" rx="1" />
        </svg>
      );
    case 'split-h':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="7" rx="1" />
          <rect x="4" y="13" width="16" height="7" rx="1" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );
    case 'mic':
      return (
        <svg {...common}>
          <rect x="9" y="2.5" width="6" height="12" rx="3" />
          <path d="M5 11.5a7 7 0 0 0 14 0" />
          <path d="M12 18.5V21" />
        </svg>
      );
    default:
      return <span className="icon" aria-hidden="true">•</span>;
  }
}

function SessionRow({ session, active = false, ghosted = false, onClick }: { session: SessionInfo; active?: boolean; ghosted?: boolean; onClick: () => void }) {
  const backend = session.kind === 'ssh'
    ? `SSH · ${session.host}`
    : session.backend === 'wsl'
      ? `WSL${session.wslDistribution ? ` · ${session.wslDistribution}` : ''} · ${session.cwd}`
      : session.backend && session.backend !== 'screen'
        ? `${backendLabel(session.backend)} · ${session.cwd}`
        : session.persistence === 'screen'
          ? `screen · ${session.cwd}`
          : `local · process only · ${session.cwd}`;
  return (
    <button type="button" className={`session-row ${active ? 'active' : ''} ${ghosted ? 'session-ghosted' : ''}`} onClick={onClick}>
      <span className={`status-dot ${session.status}`} />
      <span className="session-copy"><b>{session.name}</b><small>{backend}</small></span>
      <span className="session-state">{ghosted ? '↗' : session.status === 'connected' ? '●' : '○'}</span>
    </button>
  );
}

function sessionBackendTag(session: SessionInfo): string {
  if (session.kind === 'ssh') return 'SSH';
  if (session.backend === 'screen') return 'screen';
  if (session.backend === 'wsl') return session.wslDistribution ? `WSL · ${session.wslDistribution}` : 'WSL';
  // No backend means a session discovered from screen or history, which does not
  // record which shell is inside it — naming a shell here would be a guess.
  return session.backend ? backendLabel(session.backend) : 'local';
}

/**
 * How long a pane's size must hold still before the shell is told about it.
 * Long enough to swallow a window drag, short enough not to be felt as lag.
 */
const PTY_RESIZE_SETTLE_MS = 120;

function TerminalView({
  sessionId,
  focused,
  onStatus,
  appearance,
  terminalSettings,
  registerFocus
}: {
  sessionId?: string;
  focused?: boolean;
  onStatus: (message: string) => void;
  appearance: AppearanceSettings;
  terminalSettings: TerminalSettings;
  /** Lets the app put the keyboard back in this pane after a control took it. */
  registerFocus?: (sessionId: string, focus: (() => void) | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  // Settings are read through refs by the setup effect and the clipboard
  // wiring: those run once per pane, but the user can change a setting at any
  // time, and a pane must not keep behaving the way it was created.
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const terminalSettingsRef = useRef(terminalSettings);
  terminalSettingsRef.current = terminalSettings;
  const refitRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const host = ref.current;
    const terminal = new Terminal({
      cursorBlink: terminalSettingsRef.current.cursorBlink,
      cursorStyle: terminalSettingsRef.current.cursorStyle,
      fontFamily: fontStack(appearanceRef.current.font),
      fontSize: appearanceRef.current.fontSize,
      lineHeight: appearanceRef.current.lineHeight,
      letterSpacing: appearanceRef.current.letterSpacing,
      scrollback: terminalSettingsRef.current.scrollback,
      allowProposedApi: true,
      theme: terminalTheme(appearanceRef.current.theme),
      // No convertEol: the pane is fed by a pty, not a text file. A pty already
      // emits CR LF for a new line, and a program that sends a bare LF means
      // "down one row, same column" — turning that into a carriage return moves
      // its output to column 0 and leaves fragments of the old frame behind.
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;

    const currentApi = api();
    let disposed = false;
    let fitFrame = 0;
    // What the pty has been told, and whether it exists yet to be told. A
    // resize sent before the session is attached is dropped on the floor by the
    // main process, which would leave the shell wrapping at the wrong width for
    // the rest of its life.
    let ptyCols = 0;
    let ptyRows = 0;
    let ptyReady = false;
    let sizeTimer = 0;

    /** Match the xterm grid to the pane. True once it holds a usable size. */
    const fitToPane = (): boolean => {
      if (disposed || !host.isConnected) return false;
      // FitAddon needs a real box; skip until layout has settled.
      if (host.clientWidth < 20 || host.clientHeight < 20) return false;
      try {
        fit.fit();
      } catch {
        return false;
      }
      return terminal.cols > 0 && terminal.rows > 0;
    };

    /**
     * Forward the grid size to the shell once it has stopped changing.
     *
     * The grid follows the pane immediately, but the pty is told only when the
     * size settles, and only when it actually differs. A resize is expensive
     * and visible: the pty re-emits its screen and every full-screen program
     * redraws on it. Dragging a window edge produces one per frame, and those
     * redraws land on top of each other — which is where torn frames and
     * stranded pieces of an older frame come from.
     */
    const syncPtySize = () => {
      if (!ptyReady || !currentApi || !sessionId) return;
      if (terminal.cols === ptyCols && terminal.rows === ptyRows) return;
      window.clearTimeout(sizeTimer);
      sizeTimer = window.setTimeout(() => {
        if (disposed || !sessionId) return;
        if (terminal.cols === ptyCols && terminal.rows === ptyRows) return;
        ptyCols = terminal.cols;
        ptyRows = terminal.rows;
        currentApi.resize(sessionId, ptyCols, ptyRows);
      }, PTY_RESIZE_SETTLE_MS);
    };

    const resize = () => {
      if (fitToPane()) syncPtySize();
    };

    const scheduleFit = () => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        resize();
        // Second pass after Chrome commits flex layout / font metrics.
        fitFrame = requestAnimationFrame(resize);
      });
    };
    // Exposed so the settings effect can refit after a font change resizes cells.
    refitRef.current = scheduleFit;

    if (!currentApi) {
      scheduleFit();
      terminal.writeln('\x1b[90mZeroG Terminal\x1b[0m');
      terminal.writeln('\x1b[31mPreload API unavailable. Rebuild the app.\x1b[0m');
      statusRef.current('Preload API unavailable');
      return () => {
        disposed = true;
        cancelAnimationFrame(fitFrame);
        terminalRef.current = null;
        terminal.dispose();
      };
    }

    const removeData = currentApi.onData((eventSessionId, data) => {
      if (eventSessionId === sessionId) terminal.write(data);
    });
    const removeStatus = currentApi.onStatus((eventSessionId, status) => {
      if (eventSessionId !== sessionId) return;
      statusRef.current(status);
      // Refit after connection changes — wrong rows make prompts appear mid-pane.
      scheduleFit();
    });
    const input = terminal.onData((data) => {
      if (sessionId) currentApi.write(sessionId, data);
    });

    // Ctrl+Shift+C / Ctrl+Shift+V, copy-on-select, and OSC 52 so programs
    // running in the pane can reach the system clipboard themselves.
    const detachClipboard = attachTerminalClipboard({
      terminal,
      clipboard: currentApi,
      onError: (message) => statusRef.current(message),
      writeToPty: (text) => {
        if (sessionId) currentApi.write(sessionId, text);
      },
      pasteEventTarget: host,
      isCopyOnSelectEnabled: () => terminalSettingsRef.current.copyOnSelect
    });

    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(host);
    window.addEventListener('resize', scheduleFit);
    document.fonts?.ready?.then(() => {
      if (!disposed) scheduleFit();
    }).catch(() => undefined);

    scheduleFit();
    if (!sessionId) {
      terminal.writeln('\x1b[90mZeroG Terminal\x1b[0m');
      terminal.writeln('\x1b[90mSelect a session or create a local/SSH connection.\x1b[0m');
    } else {
      // Measure now rather than waiting for the scheduled fit: the shell should
      // start at the size it will be shown at, so its first frame is not drawn
      // for a different terminal and then redrawn over.
      const measured = fitToPane() ? { cols: terminal.cols, rows: terminal.rows } : undefined;
      if (measured) {
        ptyCols = measured.cols;
        ptyRows = measured.rows;
      }
      void currentApi.attachSession(sessionId, measured).then((attached) => {
        ptyReady = true;
        if (attached.persistence === 'process') {
          statusRef.current(`${attached.host} · ${attached.name} · process only (install screen for persistence)`);
        } else {
          statusRef.current(`${attached.host} · ${attached.name}`);
        }
        scheduleFit();
      }).catch((error) => {
        statusRef.current(error instanceof Error ? error.message : String(error));
      });
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(fitFrame);
      window.clearTimeout(sizeTimer);
      detachClipboard();
      input.dispose();
      removeData();
      removeStatus();
      observer.disconnect();
      window.removeEventListener('resize', scheduleFit);
      refitRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [sessionId]);

  // Appearance and terminal behaviour are mutable xterm options. Rebuilding the
  // Terminal to apply them would dispose the renderer and drop the pane's
  // scrollback — the same content loss the layout code deliberately avoids.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.theme = terminalTheme(appearance.theme);
    terminal.options.fontFamily = fontStack(appearance.font);
    terminal.options.fontSize = appearance.fontSize;
    terminal.options.lineHeight = appearance.lineHeight;
    terminal.options.letterSpacing = appearance.letterSpacing;
    terminal.options.scrollback = terminalSettings.scrollback;
    terminal.options.cursorStyle = terminalSettings.cursorStyle;
    terminal.options.cursorBlink = terminalSettings.cursorBlink;
    // Font changes resize the cell, so the pane holds a different number of
    // rows and columns than the pty was last told about.
    refitRef.current?.();
  }, [appearance, terminalSettings]);

  useEffect(() => {
    if (focused) terminalRef.current?.focus();
  }, [focused]);

  useEffect(() => {
    if (!sessionId || !registerFocus) return;
    registerFocus(sessionId, () => terminalRef.current?.focus());
    return () => registerFocus(sessionId, null);
  }, [sessionId, registerFocus]);

  return (
    <div className="terminal" ref={ref} onMouseDownCapture={(event) => event.preventDefault()} />
  );
}

function PanePlaceholder({ index, onCreate }: { index: number; onCreate: () => void }) {
  return (
    <article className="pane empty-pane">
      <div className="pane-title">
        <span>PANE {index}</span>
        <span className="pane-dim">EMPTY</span>
      </div>
      <div className="empty-pane-body">
        <span className="empty-glyph">+</span>
        <strong>Split ready</strong>
        <small>Open another terminal here</small>
        <button type="button" onClick={onCreate}>Choose session</button>
      </div>
    </article>
  );
}

function makeWorkspace(name: string, sessionIds: string[] = []): Workspace {
  return {
    id: `ws-${crypto.randomUUID()}`,
    name,
    sessionIds
  };
}

function App() {
  // Read once, synchronously, so the first paint already uses the stored theme
  // and font instead of flashing the defaults.
  const [settings, setSettings] = useState<Settings>(() => loadSettings(browserStorage()));
  const theme: Theme = settings.appearance.theme;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => {
    const initial = makeWorkspace('Workspace');
    return [initial];
  });
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => workspaces[0]?.id ?? '');
  const [active, setActive] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [drawerCollapsed, setDrawerCollapsed] = useState(settings.sessions.startSidebarCollapsed);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('terminals');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [overview, setOverview] = useState(false);
  const [layout, setLayout] = useState<Layout>(settings.sessions.defaultLayout);
  const [focusedSessionId, setFocusedSessionId] = useState<string>();
  const [maximizedSessionId, setMaximizedSessionId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('Workspace');
  const [localName, setLocalName] = useState('term');
  const [sshName, setSshName] = useState('');
  const [sshTarget, setSshTarget] = useState('');
  const [approval, setApproval] = useState<{ command: string; explanation: string } | null>(null);
  const [voice, setVoice] = useState<{ status: VoiceStatus; sessionId: string | null }>({ status: 'idle', sessionId: null });
  const [voiceReview, setVoiceReview] = useState<{ sessionId: string; text: string } | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const speechRef = useRef<SpeechClient | null>(null);
  const voiceTargetRef = useRef<string | null>(null);
  const voiceLimitRef = useRef<number | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [speechTest, setSpeechTest] = useState<SpeechTestState>({ status: 'idle' });
  const speechTestRecorderRef = useRef<VoiceRecorder | null>(null);
  const speechTestLimitRef = useRef<number | undefined>(undefined);
  const [localBackends, setLocalBackends] = useState<ShellBackend[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<LocalBackend>(settings.sessions.defaultBackend);
  const [wslDistribution, setWslDistribution] = useState<string>(settings.sessions.defaultWslDistribution);
  const [wslDistributions, setWslDistributions] = useState<string[]>([]);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [knownConnections, setKnownConnections] = useState<KnownConnection[]>([]);
  const [remoteScreenEntries, setRemoteScreenEntries] = useState<Array<{ session: SessionInfo; connection: KnownConnection }>>([]);
  const [remoteScreensLoading, setRemoteScreensLoading] = useState(false);

  // Each mounted pane leaves a way to put the keyboard back into its terminal.
  // Clicking a pane control — the mic above all — moves focus onto a button,
  // and marking the pane focused is not enough to take it back: a pane that was
  // already the focused one sees no prop change, so nothing pulls focus in and
  // the next keystrokes go to the button instead of the shell.
  const terminalFocusRef = useRef(new Map<string, () => void>());
  const registerTerminalFocus = useCallback((sessionId: string, focus: (() => void) | null) => {
    if (focus) terminalFocusRef.current.set(sessionId, focus);
    else terminalFocusRef.current.delete(sessionId);
  }, []);
  /** Put the keyboard back in a pane, so the user can carry on typing. */
  const focusTerminal = useCallback((sessionId: string | null | undefined) => {
    if (!sessionId) return;
    setFocusedSessionId(sessionId);
    // After the commit: the pane may still be rendering the state change that
    // preceded this call, and a dialog closing removes the focused button.
    requestAnimationFrame(() => terminalFocusRef.current.get(sessionId)?.());
  }, []);

  // Backdrop dismissal, gated on where the press started so that selecting
  // text inside a dialog cannot close it. See backdrop-dismiss.ts.
  const dismissModal = useBackdropDismiss(() => setModal(null));
  const dismissApproval = useBackdropDismiss(() => setApproval(null));
  const dismissOverview = useBackdropDismiss(() => setOverview(false));
  const dismissHistory = useBackdropDismiss(() => setHistoryOpen(false));
  const dismissSettings = useBackdropDismiss(() => setSettingsOpen(false));
  const dismissVoiceReview = useBackdropDismiss(() => closeVoiceReview());

  // Every settings edit goes through updateSection, so a control cannot store a
  // value the schema would reject, and every edit is persisted as it is made —
  // there is no Save button to forget to press.
  const changeSetting = useCallback(<K extends SettingsSection>(section: K, patch: Partial<Settings[K]>) => {
    setSettings((current) => {
      const next = updateSection(current, section, patch);
      saveSettings(browserStorage(), next);
      return next;
    });
  }, []);

  const resetSettings = useCallback((section: SettingsSection) => {
    setSettings((current) => {
      const next = resetSection(current, section);
      saveSettings(browserStorage(), next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.id === activeWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, activeWorkspaceId]
  );

  const workspaceSessions = useMemo(() => {
    if (!activeWorkspace) return sessions;
    const known = new Set(activeWorkspace.sessionIds);
    const owned = sessions.filter((session) => known.has(session.id));
    // Keep unassigned sessions visible in the first workspace until claimed.
    if (activeWorkspace.id === workspaces[0]?.id) {
      const assigned = new Set(workspaces.flatMap((item) => item.sessionIds));
      const orphans = sessions.filter((session) => !assigned.has(session.id));
      const byId = new Map([...owned, ...orphans].map((session) => [session.id, session]));
      return [...byId.values()];
    }
    return owned;
  }, [activeWorkspace, sessions, workspaces]);

  const refresh = useCallback(async () => {
    const currentApi = api();
    setSessionsLoading(true);
    setSessionsError(null);
    if (!currentApi) {
      setSessionsError('Preload API unavailable');
      setStatus('Preload API unavailable');
      setSessionsLoading(false);
      return;
    }
    try {
      const items = await currentApi.listSessions();
      setSessions(items);
      setStatus(items.length ? `${items.length} session${items.length === 1 ? '' : 's'}` : 'No sessions');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessionsError(message);
      setStatus(message);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const currentApi = api();
    if (!currentApi) return;
    currentApi.listBackends?.().then(setLocalBackends).catch(() => setLocalBackends([]));
  }, []);

  useEffect(() => {
    if (selectedBackend !== 'wsl') {
      setWslDistributions([]);
      setWslDistribution('');
      return;
    }
    const currentApi = api();
    if (!currentApi) return;
    currentApi.listWslDistributions?.().then(setWslDistributions).catch(() => setWslDistributions([]));
  }, [selectedBackend]);

  useEffect(() => {
    if (!historyOpen) {
      setHistoryEntries([]);
      return;
    }
    const currentApi = api();
    if (!currentApi) return;
    currentApi.listHistory?.().then(setHistoryEntries).catch(() => setHistoryEntries([]));
  }, [historyOpen]);

  useEffect(() => {
    const currentApi = api();
    const sshHost = normalizeHost((active?.kind === 'ssh' ? active.host : '') || (focusedSessionId ? sessions.find((s) => s.id === focusedSessionId)?.host : '') || '');
    const matching = sshHost ? knownConnections.filter((connection) => normalizeHost(connection.hostName ?? '') === sshHost || connection.alias === sshHost) : [];
    if (matching.length === 0) {
      setRemoteScreenEntries([]);
      return;
    }
    if (!currentApi?.discoverRemoteScreens) return;
    setRemoteScreensLoading(true);
    Promise.allSettled(
      matching.map((connection) => currentApi.discoverRemoteScreens(connection))
    )
      .then((results) => {
        const entries: Array<{ session: SessionInfo; connection: KnownConnection }> = [];
        results.forEach((result, index) => {
          if (result.status === 'fulfilled' && Array.isArray(result.value)) {
            result.value.forEach((session) => {
              entries.push({ session, connection: matching[index] });
            });
          }
        });
        setRemoteScreenEntries(entries);
      })
      .catch(() => setRemoteScreenEntries([]))
      .finally(() => setRemoteScreensLoading(false));
  }, [knownConnections, active?.host, sessions, focusedSessionId]);

  useEffect(() => {
    const currentApi = api();
    if (!currentApi) return;
    currentApi.listKnownConnections?.().then(setKnownConnections).catch(() => setKnownConnections([]));
  }, []);

  useEffect(() => {
    if (!active && workspaceSessions.length) {
      setActive(workspaceSessions[0]);
    }
  }, [active, workspaceSessions]);

  // Esc while listening, in the capture phase so it reaches here rather than
  // the shell. The pane holds the keyboard during a recording — that is the
  // point, so typing carries on working — and xterm would otherwise consume the
  // key first and send it to the pty.
  useEffect(() => {
    if (voice.status !== 'listening') return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelVoice();
      setStatus('Voice cancelled');
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [voice.status]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (settingsOpen) {
          event.preventDefault();
          setSettingsOpen(false);
          return;
        }
        if (voiceReview) {
          event.preventDefault();
          closeVoiceReview();
          return;
        }
        if (overview) {
          event.preventDefault();
          setOverview(false);
          return;
        }
        if (approval) {
          event.preventDefault();
          setApproval(null);
          return;
        }
        if (modal) {
          event.preventDefault();
          setModal(null);
          return;
        }
        if (historyOpen) {
          event.preventDefault();
          setHistoryOpen(false);
          return;
        }
      }

      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'o') {
        event.preventDefault();
        setOverview((value) => !value);
      }
      if (key === 'n') {
        event.preventDefault();
        setWorkspaceName(nextWorkspaceName(workspaces));
        setModal('workspace');
      }
      if (key === 't') {
        event.preventDefault();
        openSessionDialog('local');
      }
      if (key === 'l') {
        event.preventDefault();
        // Match the layout buttons: a maximized pane would otherwise mask the change.
        setMaximizedSessionId(null);
        setLayout((value) => (value === 'stack' ? 'split-v' : 'stack'));
      }
      if (key === 'b') {
        event.preventDefault();
        setDrawerCollapsed((value) => !value);
      }
      // Matched on code, not key: with Shift held, a comma reports as '<' on
      // most layouts, so event.key would never equal ','.
      if (event.code === 'Comma') {
        event.preventDefault();
        setSettingsOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overview, approval, modal, historyOpen, settingsOpen, voiceReview, voice.status, workspaces, activeWorkspace, workspaceSessions]);

  const paneCount = layout === 'stack' ? 1 : layout === 'grid' ? 4 : 2;
  // Keep every workspace terminal mounted while changing layouts. Hiding a
  // pane must not dispose its xterm renderer and lose its scrollback/content.
  const paneSessions = workspaceSessions.slice(0, 4);
  const renderedPaneCount = Math.max(paneCount, paneSessions.length);
  // A pane maximized in another workspace has no match here, and the grid would
  // then hide every pane including placeholders. Derive the effective id so that
  // state is unrepresentable, whatever leaves maximizedSessionId stale.
  const maximizedPaneId = paneSessions.some((session) => session.id === maximizedSessionId)
    ? maximizedSessionId
    : null;
  // Single-pane layouts show the selected session, not pane 0 — otherwise the
  // breadcrumb and sidebar name one session while keystrokes go to another.
  const stackedSessionId =
    paneSessions.find((session) => session.id === active?.id)?.id ?? paneSessions[0]?.id;
  const isPaneVisible = (session: SessionInfo, index: number) =>
    layout === 'stack' ? session.id === stackedSessionId : index < paneCount;

  const attach = async (session: SessionInfo) => {
    setActive(session);
    // Selecting a terminal makes it the keyboard target too, so typing goes
    // where the sidebar says it does.
    setFocusedSessionId(session.id);
    const index = paneSessions.findIndex((item) => item.id === session.id);
    if (maximizedPaneId) {
      // A maximized pane is effectively single-pane: follow the selection
      // rather than leaving the chosen terminal off screen.
      setMaximizedSessionId(session.id);
    } else if (index >= paneCount && layout !== 'stack') {
      // The current split does not render this pane; widen so it is visible.
      setLayout('grid');
    }
    setStatus(
      session.persistence === 'process'
        ? `${session.host} · ${session.name} · process only (install screen for persistence)`
        : `${session.host} · ${session.name}`
    );
    setOverview(false);
  };

  const claimSession = (session: SessionInfo, workspaceId = activeWorkspaceId) => {
    setWorkspaces((current) =>
      current.map((workspace) => {
        if (workspace.id !== workspaceId) {
          return {
            ...workspace,
            sessionIds: workspace.sessionIds.filter((id) => id !== session.id)
          };
        }
        if (workspace.sessionIds.includes(session.id)) return workspace;
        return { ...workspace, sessionIds: [...workspace.sessionIds, session.id] };
      })
    );
  };

  const createWorkspace = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = workspaceName.trim() || nextWorkspaceName(workspaces);
    const workspace = makeWorkspace(name);
    setWorkspaces((current) => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
    setActive(null);
    setModal(null);
    setStatus(`Workspace “${name}” ready`);
  };

  const createLocal = async (event: React.FormEvent) => {
    event.preventDefault();
    const currentApi = api();
    if (!currentApi) return;
    if (workspaceSessions.length >= 4) {
      setStatus('This workspace supports up to 4 sessions.');
      setModal(null);
      return;
    }
    setBusy(true);
    try {
      const session = await currentApi.createLocalSession({ name: localName, backend: selectedBackend, wslDistribution: selectedBackend === 'wsl' ? wslDistribution : undefined });
      setSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
      claimSession(session);
      setFocusedSessionId(session.id);
      setMaximizedSessionId(null);
      setLayout(layoutForSessionCount(workspaceSessions.length + 1));
      setModal(null);
      await attach(session);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const createSsh = async (event: React.FormEvent) => {
    event.preventDefault();
    const currentApi = api();
    if (!currentApi) return;
    if (workspaceSessions.length >= 4) {
      setStatus('This workspace supports up to 4 sessions.');
      setModal(null);
      return;
    }
    setBusy(true);
    try {
      const session = await currentApi.createSshSession({ name: sshName || undefined, target: sshTarget });
      setSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
      claimSession(session);
      setFocusedSessionId(session.id);
      setMaximizedSessionId(null);
      setLayout(layoutForSessionCount(workspaceSessions.length + 1));
      setModal(null);
      await attach(session);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const attachRemoteScreen = async (session: SessionInfo, connection: KnownConnection) => {
    try {
      const currentApi = api();
      if (!currentApi) return;
      setStatus(`Attaching to ${session.name} on ${connection.alias}…`);
      const result = await currentApi.buildRemoteScreenAttach?.(connection, session.screenName ?? session.name);
      const args = result?.args;
      const dashDashIndex = Array.isArray(args) ? args.indexOf('--') : -1;
      const destination = dashDashIndex > 0 ? args[dashDashIndex - 1] : (connection.hostName ?? connection.alias);
      const ssh = await currentApi.createSshSession({ target: destination, name: session.name });
      const screenName = session.screenName ?? session.name;
      const attached = { ...ssh, screenName, persistence: 'screen' as const, backend: 'screen' as const };
      setSessions((current) => {
        const exists = current.some((item) => item.id === attached.id);
        return exists ? current.map((item) => item.id === attached.id ? attached : item) : [...current, attached];
      });
      claimSession(attached);
      await attach(attached);
      await currentApi.attachSession(attached.id);
      const screenCommand = args && dashDashIndex > 0 ? args.slice(dashDashIndex + 1).join(' ') : `screen -x ${screenName}`;
      await waitForShellPrompt(currentApi, attached.id);
      currentApi.write(attached.id, `${screenCommand}\r`);
      await refresh();
      setStatus(`Connected to ${session.name} on ${connection.alias}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  // Wait until a freshly attached remote shell looks ready for input.
  //
  // PTY output arrives in arbitrary chunks, so matching has to run against a
  // rolling buffer: a prompt split across two reads ("user@host:~" then "$ ")
  // would never match a per-chunk test. Prompt shape is only the fast path —
  // it varies too much across shells and colour schemes to depend on — so the
  // primary signal is output going quiet, with an overall cap as a backstop.
  const waitForShellPrompt = (currentApi: TerminalApi, sessionId: string) => new Promise<void>((resolve) => {
    let finished = false;
    let buffer = '';
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let removeData: (() => void) | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(quietTimer);
      clearTimeout(capTimer);
      removeData?.();
      resolve();
    };
    const capTimer = setTimeout(finish, PROMPT_WAIT_CAP_MS);
    removeData = currentApi.onData((eventSessionId, data) => {
      if (eventSessionId !== sessionId) return;
      buffer = (buffer + data).slice(-PROMPT_BUFFER_CHARS);
      if (looksLikeShellPrompt(buffer)) {
        finish();
        return;
      }
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, PROMPT_QUIET_MS);
    });
  });

  const openNewWorkspace = () => {
    setWorkspaceName(nextWorkspaceName(workspaces));
    setModal('workspace');
  };

  /**
   * Open the new-session dialog on one of its tabs.
   *
   * Both tabs are prepared whichever one is asked for, because the other is now
   * one click away: landing on SSH and switching to Local must not find a stale
   * terminal name from the last time the dialog was open. Switching tabs itself
   * touches no fields, so anything already typed on either side survives.
   */
  const openSessionDialog = (kind: SessionDialogKind, options?: { sshTarget?: string }) => {
    setLocalName(nextTerminalName(activeWorkspace?.name ?? 'term', workspaceSessions));
    setSelectedBackend(resolveDefaultBackend(settings.sessions.defaultBackend, localBackends));
    setWslDistribution(settings.sessions.defaultWslDistribution);
    if (options?.sshTarget !== undefined) setSshTarget(options.sshTarget);
    setModal(kind);
  };

  const openNewLocalTerminal = () => openSessionDialog('local');

  const renderScreensTab = () => {
    const sshHost = normalizeHost((active?.kind === 'ssh' ? active.host : '') || (focusedSessionId ? sessions.find((s) => s.id === focusedSessionId)?.host : '') || '');
    const hostGroups: Record<string, Array<{ session: SessionInfo; connection: KnownConnection }>> = sshHost
      ? remoteScreenEntries
          .filter((entry) => normalizeHost(entry.connection.hostName ?? '') === sshHost || entry.connection.alias === sshHost)
          .reduce((acc, entry) => {
            const key = entry.connection.hostName || entry.connection.alias;
            (acc[key] = acc[key] || []).push(entry);
            return acc;
          }, {} as Record<string, Array<{ session: SessionInfo; connection: KnownConnection }>>)
      : {};
    const localScreens = sessions.filter((session) => session.persistence === 'screen' && !workspaceSessions.some((item) => item.id === session.id));
    const hasRemote = Object.keys(hostGroups).length > 0;
    const hasLocal = localScreens.length > 0;
    if (!hasRemote && !hasLocal) return <div className="session-empty"><b>No screens</b><small>{sshHost ? 'No remote screens found for this host.' : 'Open a remote session to discover screens, or start a local screen.'}</small></div>;
    const nodes: React.ReactNode[] = [];
    if (hasRemote) {
      for (const [host, group] of Object.entries(hostGroups)) {
        const remoteGroup = group as Array<{ session: SessionInfo; connection: KnownConnection }>;
        const label = <div key={`${host}-label`} className="session-group-label">{host}</div>;
        const items = remoteGroup.map(({ session }) => {
          const connection = remoteGroup.find((item) => item.session.id === session.id)?.connection;
          return (
            <SessionRow
              key={session.id}
              session={session}
              ghosted
              onClick={async () => {
                if (!connection) return;
                setStatus(`Attaching ${session.name}…`);
                const currentApi = api();
                if (!currentApi) return;
                try {
                  const result = await currentApi.buildRemoteScreenAttach?.(connection, session.screenName ?? session.name);
                  const args = result?.args;
                  const dashDashIndex = Array.isArray(args) ? args.indexOf('--') : -1;
                  const destination = dashDashIndex > 0 ? args[dashDashIndex - 1] : (connection.hostName ?? connection.alias);
                  const ssh = await currentApi.createSshSession({ target: destination, name: session.name });
                  const attached = { ...ssh, screenName: session.screenName ?? session.name, persistence: 'screen' as const, backend: 'screen' as const };
                  setSessions((current) => current.some((item) => item.id === attached.id) ? current.map((item) => item.id === attached.id ? attached : item) : [...current, attached]);
                  claimSession(attached);
                  await attach(attached);
                  await currentApi.attachSession(attached.id);
                  const screenCommand = args && dashDashIndex > 0 ? args.slice(dashDashIndex + 1).join(' ') : `screen -x ${session.screenName ?? session.name}`;
                  await waitForShellPrompt(currentApi, attached.id);
                  currentApi.write(attached.id, `${screenCommand}\r`);
                  await refresh();
                  setStatus(`Connected to ${session.name}`);
                } catch (error) {
                  setStatus(error instanceof Error ? error.message : String(error));
                }
              }}
            />
          );
        });
        nodes.push(label, ...items);
      }
    }

    if (hasLocal && !hasRemote) {
      nodes.push(<div key="local-label" className="session-group-label">local</div>);
      localScreens.forEach((session) => {
        nodes.push(
          <SessionRow
            key={session.id}
            session={session}
            ghosted
            onClick={() => { claimSession(session); void attach(session); setStatus(`Reconnecting to ${session.name}…`); }}
          />
        );
      });
    }

    return <>{nodes}</>;
  };

  const paneClass =
    layout === 'split-v'
      ? 'pane-grid split-v'
      : layout === 'split-h'
        ? 'pane-grid split-h'
        : layout === 'grid'
          ? 'pane-grid grid'
          : 'pane-grid';
  const toggleMaximize = (sessionId: string) => {
    setFocusedSessionId(sessionId);
    setMaximizedSessionId((current) => current === sessionId ? null : sessionId);
  };
  const cycleMaximizedSession = (direction: -1 | 1) => {
    if (!maximizedPaneId || workspaceSessions.length < 2) return;
    const currentIndex = workspaceSessions.findIndex((session) => session.id === maximizedPaneId);
    const nextIndex = (currentIndex + direction + workspaceSessions.length) % workspaceSessions.length;
    const next = workspaceSessions[nextIndex];
    setFocusedSessionId(next.id);
    setActive(next);
    setMaximizedSessionId(next.id);
  };

  // One speech client for the whole window: it owns the worker for the built-in
  // engine and the request for the local-server engine, so the pane mic and the
  // settings test always run whatever is configured right now.
  const speechClient = () => {
    speechRef.current ??= new SpeechClient({
      // Worker's onmessage is typed around MessageEvent; the client only reads
      // `.data`, so this narrowing cast is safe and stays at the boundary.
      createWorker: () =>
        new Worker(new URL('./voice-worker.ts', import.meta.url), { type: 'module' }) as unknown as SpeechWorker
    });
    return speechRef.current;
  };

  const reportSpeechProgress = (progress: { kind: 'loading'; progress: number | null } | { kind: 'notice'; message: string }) => {
    if (progress.kind === 'notice') {
      setStatus(progress.message);
      return;
    }
    if (progress.progress !== null) setStatus(`Loading speech model… ${Math.round(progress.progress)}%`);
  };

  const cancelVoice = () => {
    const target = voiceTargetRef.current;
    window.clearTimeout(voiceLimitRef.current);
    recorderRef.current?.cancel();
    recorderRef.current = null;
    voiceTargetRef.current = null;
    setVoice({ status: 'idle', sessionId: null });
    focusTerminal(target);
  };

  /** Close the review dialog and hand the keyboard back to its pane. */
  const closeVoiceReview = () => {
    const target = voiceReview?.sessionId;
    setVoiceReview(null);
    focusTerminal(target);
  };

  const finishListening = async () => {
    const recorder = recorderRef.current;
    const target = voiceTargetRef.current;
    if (!recorder || !target) return;
    window.clearTimeout(voiceLimitRef.current);
    recorderRef.current = null;
    setVoice({ status: 'transcribing', sessionId: target });
    setStatus('Transcribing…');
    const audio = await recorder.stop();
    if (!audio || isMostlySilence(audio, settings.speech.silenceThreshold)) {
      voiceTargetRef.current = null;
      setVoice({ status: 'idle', sessionId: null });
      setStatus('Voice: no speech detected — lower the silence threshold in Settings if this is wrong');
      focusTerminal(target);
      return;
    }
    try {
      const result = await speechClient().transcribe(audio, settings.speech, reportSpeechProgress);
      voiceTargetRef.current = null;
      setVoice({ status: 'idle', sessionId: null });
      if (!result.text) {
        setStatus('Voice: nothing transcribed');
        focusTerminal(target);
        return;
      }
      // Review mode holds the transcript in a dialog instead of typing it, for
      // when a wrong word in a shell is worse than a second keystroke. The
      // dialog wants the keyboard, so the pane gets it back when that closes.
      if (settings.ai.voiceInsert === 'review') {
        setVoiceReview({ sessionId: target, text: result.text });
        setStatus(`Voice: review "${result.text}"`);
        return;
      }
      api()?.write(target, result.text);
      setStatus(`Voice: "${result.text}"`);
      focusTerminal(target);
    } catch (error) {
      voiceTargetRef.current = null;
      setVoice({ status: 'idle', sessionId: null });
      setStatus(`Voice error: ${error instanceof Error ? error.message : String(error)}`);
      focusTerminal(target);
    }
  };

  const toggleVoice = async (session: SessionInfo) => {
    if (voice.status === 'listening' && voice.sessionId === session.id) {
      await finishListening();
      return;
    }
    if (voice.status !== 'idle') return;
    // One microphone, one capture: the settings test and a pane cannot both hold it.
    if (speechTest.status !== 'idle') {
      setStatus('The speech test in Settings is using the microphone');
      return;
    }
    const recorder = new VoiceRecorder();
    try {
      await recorder.start();
    } catch (error) {
      setStatus(`Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    recorderRef.current = recorder;
    voiceTargetRef.current = session.id;
    setVoice({ status: 'listening', sessionId: session.id });
    // The click left the keyboard on the mic button, where Space and Enter would
    // toggle it again. Recording does not need the focus, so the pane keeps it.
    focusTerminal(session.id);
    window.clearTimeout(voiceLimitRef.current);
    voiceLimitRef.current = window.setTimeout(() => void finishListening(), settings.speech.maxUtteranceSeconds * 1000);
    // Esc discards rather than finishes: worth saying, now that the keyboard is
    // in the pane and Esc is a key the user may well reach for.
    setStatus(`Listening on ${session.name}… click the mic again to transcribe, Esc to discard`);
  };

  const finishSpeechTest = async () => {
    const recorder = speechTestRecorderRef.current;
    if (!recorder) return;
    window.clearTimeout(speechTestLimitRef.current);
    speechTestRecorderRef.current = null;
    setSpeechTest({ status: 'transcribing', message: 'Transcribing…', transcript: null, error: null });
    const audio = await recorder.stop();
    if (!audio) {
      setSpeechTest({ status: 'idle', error: 'Nothing was recorded.' });
      return;
    }
    // Measured before transcribe(), which transfers the buffer away.
    const level = rootMeanSquare(audio);
    const belowThreshold = isMostlySilence(audio, settings.speech.silenceThreshold);
    try {
      const result = await speechClient().transcribe(audio, settings.speech, (progress) => {
        setSpeechTest((current) => ({
          ...current,
          message: progress.kind === 'notice'
            ? progress.message
            : progress.progress !== null
              ? `Loading speech model… ${Math.round(progress.progress)}%`
              : 'Loading speech model…'
        }));
      });
      setSpeechTest({
        status: 'idle',
        transcript: result.text,
        elapsedMs: result.elapsedMs,
        level,
        // The test transcribes even below the threshold on purpose: seeing the
        // words next to the level is how the threshold gets tuned.
        message: belowThreshold
          ? 'Below the silence threshold — a real recording at this level would have been discarded.'
          : result.engine === 'server'
            ? 'Transcribed by the local server.'
            : 'Transcribed by the built-in engine.',
        error: null
      });
    } catch (error) {
      setSpeechTest({
        status: 'idle',
        level,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };

  const runSpeechTest = async () => {
    if (speechTest.status === 'recording') {
      await finishSpeechTest();
      return;
    }
    if (speechTest.status === 'transcribing') return;
    if (voice.status !== 'idle') {
      setSpeechTest({ status: 'idle', error: 'A terminal pane is recording — stop that first.' });
      return;
    }
    const recorder = new VoiceRecorder();
    try {
      await recorder.start();
    } catch (error) {
      setSpeechTest({
        status: 'idle',
        error: `Microphone unavailable: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }
    speechTestRecorderRef.current = recorder;
    setSpeechTest({ status: 'recording', message: 'Listening… say a command, then stop.', transcript: null, error: null });
    window.clearTimeout(speechTestLimitRef.current);
    speechTestLimitRef.current = window.setTimeout(() => void finishSpeechTest(), settings.speech.maxUtteranceSeconds * 1000);
  };

  // Release the microphone and the worker with the window, not on the next
  // garbage collection: a live MediaStream keeps the recording indicator on.
  useEffect(() => () => {
    window.clearTimeout(voiceLimitRef.current);
    window.clearTimeout(speechTestLimitRef.current);
    recorderRef.current?.cancel();
    speechTestRecorderRef.current?.cancel();
    speechRef.current?.dispose();
  }, []);

  const closePane = async (session: SessionInfo) => {
    if (voice.sessionId === session.id) cancelVoice();
    const remaining = workspaceSessions.filter((item) => item.id !== session.id);
    setWorkspaces((current) =>
      current.map((workspace) => ({
        ...workspace,
        sessionIds: workspace.sessionIds.filter((id) => id !== session.id)
      }))
    );
    if (active?.id === session.id) setActive(remaining[0] ?? null);
    if (focusedSessionId === session.id) setFocusedSessionId(remaining[0]?.id);
    if (maximizedSessionId === session.id) setMaximizedSessionId(null);
    setLayout(layoutForSessionCount(remaining.length));

    const currentApi = api();
    if (currentApi) {
      try {
        await currentApi.closeSession(session.id);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setStatus(
      session.persistence === 'screen'
        ? `Closed ${session.name} · screen session survives`
        : session.kind === 'ssh'
          ? `Closed ${session.name} · SSH connection ended`
          : `Closed ${session.name} · process ended`
    );
    void refresh();
  };

  return (
    <main className={`app-shell ${drawerCollapsed ? 'drawer-collapsed' : ''}`}>
      <header className="window-bar">
        <div className="window-brand">
          <span className="brand-mark">ZG</span>
          <span className="brand-name">ZeroG</span>
        </div>
        <div className="workspace-tabs">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className={`workspace-tab ${workspace.id === activeWorkspace?.id ? 'active' : ''}`}
              onClick={() => {
                setActiveWorkspaceId(workspace.id);
                const first = sessions.find((session) => workspace.sessionIds.includes(session.id));
                setActive(first ?? null);
                // Do not leave focus pointing at a terminal in the workspace we just left.
                setFocusedSessionId(first?.id);
              }}
            >
              <span className="tab-dot" />
              {workspace.name}
              <span className="tab-meta">{workspace.sessionIds.length || (workspace.id === workspaces[0]?.id ? workspaceSessions.length : 0)}</span>
            </button>
          ))}
        </div>
        <div className="window-actions">
          <button
            type="button"
            className="bar-button"
            onClick={() => setOverview((value) => !value)}
            title="Session overview (Ctrl+Shift+O)"
          >
            <Icon name="grid" />
            <span>Overview</span>
          </button>
          <button
            type="button"
            className="bar-button"
            onClick={openNewWorkspace}
            title="New workspace (Ctrl+Shift+N)"
          >
            <Icon name="plus" />
            <span>New</span>
          </button>
          <button
            type="button"
            className="bar-button"
            onClick={async () => {
              const currentApi = api();
              if (!currentApi) return;
              const suggestion = await currentApi.requestAiCommand();
              if (settings.ai.requireApproval) {
                setApproval(suggestion);
                return;
              }
              // Approval turned off means the suggestion runs — the setting says so.
              const target = active?.id ?? focusedSessionId;
              if (!target) {
                setStatus('No terminal selected for the suggestion');
                return;
              }
              currentApi.write(target, `${suggestion.command}\r`);
              setStatus(`Ran suggestion: ${suggestion.command}`);
            }}
          >
            <Icon name="spark" />
            <span>Suggest</span>
          </button>
          <button
            type="button"
            className="bar-button theme-button"
            onClick={() => changeSetting('appearance', { theme: theme === 'dark' ? 'light' : 'dark' })}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            aria-pressed={theme === 'light'}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <button
            type="button"
            className="avatar"
            title="Settings (Ctrl+Shift+,)"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(true)}
          >
            S
          </button>
        </div>
      </header>

      <div className="body-shell">
        <nav className="rail" aria-label="Workspace navigation">
          <button
            type="button"
            className="rail-button"
            title={drawerCollapsed ? 'Show sessions sidebar (Ctrl+Shift+B)' : 'Hide sessions sidebar (Ctrl+Shift+B)'}
            onClick={() => setDrawerCollapsed((value) => !value)}
          >
            <Icon name={drawerCollapsed ? 'panel-left-open' : 'panel-left'} />
          </button>
          <button type="button" className={`rail-button ${!drawerCollapsed ? 'active' : ''}`} title="Sessions" onClick={() => setDrawerCollapsed(false)}>
            <Icon name="sessions" />
          </button>
          <button type="button" className="rail-button" onClick={() => setOverview(true)} title="Overview">
            <Icon name="grid" />
          </button>
          <span className="rail-spacer" />
          <button type="button" className="rail-button" onClick={() => openSessionDialog('ssh')} title="Connect SSH">
            <Icon name="ssh" />
          </button>
          <button
            type="button"
            className={`rail-button ${settingsOpen ? 'active' : ''}`}
            title="Settings (Ctrl+Shift+,)"
            aria-label="Settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
          >
            <Icon name="settings" />
          </button>
        </nav>

        {!drawerCollapsed && (
          <aside className="session-drawer">
            <div className="drawer-head">
              <div>
                <span className="eyebrow">WORKSPACE</span>
                <h1>{activeWorkspace?.name ?? 'Sessions'}</h1>
              </div>
              <div className="drawer-head-actions">
                <button
                  type="button"
                  className="square-button"
                  onClick={() => setDrawerCollapsed(true)}
                  title="Hide sessions sidebar"
                >
                  <Icon name="panel-left" />
                </button>
                <button
                  type="button"
                  className="square-button history-button"
                  onClick={() => setHistoryOpen((value) => !value)}
                  title="Session history"
                  aria-label="Open session history"
                  aria-expanded={historyOpen}
                >
                  <Icon name="history" />
                </button>
                <button
                  type="button"
                  className="square-button"
                  onClick={openNewLocalTerminal}
                  title="New local terminal"
                  aria-label="New local terminal"
                >
                  <Icon name="plus" />
                </button>
              </div>
            </div>

            <div className="drawer-tools" role="tablist" aria-label="Session inventory">
              {(['terminals', 'screens', 'connections'] as const).map((tab) => {
                const labels: Record<SidebarTab, string> = { terminals: 'Terminals', screens: 'Screens', connections: 'Connections' };
                const count = tab === 'terminals'
                  ? workspaceSessions.length
                  : tab === 'screens'
                    ? sessions.filter((session) => (session.persistence === 'screen' || session.screenName) && !workspaceSessions.some((item) => item.id === session.id)).length + remoteScreenEntries.length
                    : sessions.filter((session) => session.kind === 'ssh').length;
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={sidebarTab === tab}
                    className={`drawer-tool ${sidebarTab === tab ? 'active' : ''}`}
                    key={tab}
                    onClick={() => setSidebarTab(tab)}
                  >
                    {labels[tab]} <span>{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="session-list" role="tabpanel">
              {sessionsLoading ? (
                <div className="session-empty"><b>Loading sessions…</b><small>Checking available terminals and durable sessions.</small></div>
              ) : sessionsError ? (
                <div className="session-empty session-error"><b>Session inventory unavailable</b><small>{sessionsError}</small><button type="button" onClick={() => void refresh()}>Retry</button></div>
              ) : sidebarTab === 'terminals' ? (
                workspaceSessions.length ? workspaceSessions.map((session) => (
                  <SessionRow key={session.id} session={session} active={active?.id === session.id} onClick={() => void attach(session)} />
                )) : <div className="session-empty"><b>No terminals yet</b><small>Add a local terminal or SSH connection to this workspace.</small></div>
              ) : sidebarTab === 'screens' ? (
                  renderScreensTab()
                ) : sidebarTab === 'connections' ? (
                knownConnections.length ? knownConnections.map((connection) => (
                  <button type="button" className="session-row" key={connection.alias} onClick={() => openSessionDialog('ssh', { sshTarget: connection.hostName ?? connection.alias })}>
                    <span className="status-dot" />
                    <span className="session-copy"><b>{connection.alias}</b><small>{connection.hostName ? `${connection.user ?? ''}${connection.user ? '@' : ''}${connection.hostName}${connection.port ? `:${connection.port}` : ''}` : 'Saved SSH connection'}</small></span>
                    <span className="session-state">→</span>
                  </button>
                )) : <div className="session-empty"><b>No saved connections</b><small>Add Host entries to ~/.ssh/config to populate connections.</small></div>
              ) : (
                sessions.filter((session) => session.kind === 'ssh' && session.scope === 'remote' && session.source === 'discovered').length ? sessions.filter((session) => session.kind === 'ssh' && session.scope === 'remote' && session.source === 'discovered').map((session) => (
                  <SessionRow key={session.id} session={session} ghosted onClick={async () => { claimSession(session); setStatus(`Attaching remote screen ${session.name}…`); const currentApi = api(); if (!currentApi) return; try { const result = await currentApi.buildRemoteScreenAttach?.({ alias: session.host, hostName: session.host }, session.screenName ?? session.name); const destination = result?.args?.find((arg) => arg.includes('@') || !arg.startsWith('-')) ?? session.host; const ssh = await currentApi.createSshSession({ target: destination, name: session.name }); setSessions((current) => current.map((item) => item.id === session.id ? ssh : item)); await attach(ssh); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); } }} />
                )) : <div className="session-empty"><b>No remote screens</b><small>Remote screen sessions will appear here after discovery.</small></div>
              )}
            </div>

            <div className="drawer-bottom">
              <button type="button" className="drawer-action" onClick={openNewLocalTerminal}>
                <Icon name="plus" /> Local terminal <kbd>⌘⇧T</kbd>
              </button>
              <button type="button" className="drawer-action" onClick={() => openSessionDialog('ssh')}>
                <Icon name="ssh" /> Connect SSH
              </button>
              <div className="drawer-status">
                <span className="status-dot connected" />
                {status}
              </div>
            </div>
          </aside>
        )}

        <section className="workspace">
          <div className="workspace-head">
            <div className="location">
              {drawerCollapsed && (
                <button
                  type="button"
                  className="inline-restore"
                  onClick={() => setDrawerCollapsed(false)}
                  title="Show sessions sidebar"
                >
                  <Icon name="panel-left-open" />
                </button>
              )}
              <span className="connection-dot" />
              <span>{active?.host ?? 'local'}</span>
              <span className="slash">/</span>
              <span>{active?.cwd ?? '~'}</span>
              <span className="slash">/</span>
              <span className="muted-text">{active?.name ?? activeWorkspace?.name ?? 'no session'}</span>
            </div>
            <div className="layout-controls">
              <span className="control-label">LAYOUT</span>
              <button
                type="button"
                className={layout === 'stack' || maximizedPaneId ? 'layout-button active' : 'layout-button'}
                onClick={() => {
                  if (maximizedPaneId) {
                    setMaximizedSessionId(null);
                  } else if (workspaceSessions.length > 1) {
                    const target = focusedSessionId ?? active?.id ?? workspaceSessions[0]?.id;
                    if (target) setMaximizedSessionId(target);
                  } else {
                    setLayout('stack');
                  }
                }}
                title={maximizedPaneId ? 'Restore panes' : workspaceSessions.length > 1 ? 'Maximize focused pane' : 'Single pane'}
              >
                <Icon name="stack" />
              </button>
              <button type="button" className={layout === 'split-v' && !maximizedPaneId ? 'layout-button active' : 'layout-button'} onClick={() => { setMaximizedSessionId(null); setLayout('split-v'); }} title="Vertical split">
                <Icon name="split-v" />
              </button>
              <button type="button" className={layout === 'split-h' && !maximizedPaneId ? 'layout-button active' : 'layout-button'} onClick={() => { setMaximizedSessionId(null); setLayout('split-h'); }} title="Horizontal split">
                <Icon name="split-h" />
              </button>
              <button type="button" className={layout === 'grid' && !maximizedPaneId ? 'layout-button active' : 'layout-button'} onClick={() => { setMaximizedSessionId(null); setLayout('grid'); }} title="Four-pane grid">
                <Icon name="grid" />
              </button>
            </div>
          </div>

          <div className={`${paneClass} ${maximizedPaneId ? 'maximized-pane-grid' : ''}`}>
            {Array.from({ length: renderedPaneCount }, (_, index) => {
              const paneSession = paneSessions[index];
              if (!paneSession) {
                return <PanePlaceholder key={index} index={index + 1} onCreate={openNewLocalTerminal} />;
              }
              const paneVoice = voice.sessionId === paneSession.id && voice.status !== 'idle' ? voice.status : null;
              return (
                <article
                  className={`pane terminal-pane ${focusedSessionId === paneSession.id ? 'focused' : ''} ${maximizedPaneId === paneSession.id ? 'maximized-pane' : ''} ${isPaneVisible(paneSession, index) ? '' : 'overflow-pane'}`}
                  key={paneSession.id}
                  onMouseDown={() => setFocusedSessionId(paneSession.id)}
                >
                  <div className="pane-title">
                    <span>
                      <span className="pane-live" /> {paneSession.name}
                    </span>
                    <span className="pane-actions">
                      {maximizedPaneId && (
                        <>
                          <button type="button" className="pane-nav" onClick={() => cycleMaximizedSession(-1)} title="Previous session">
                            <Icon name="chevron-left" />
                          </button>
                          <button type="button" className="pane-nav" onClick={() => cycleMaximizedSession(1)} title="Next session">
                            <Icon name="chevron-right" />
                          </button>
                        </>
                      )}
                      {busy ? 'connecting…' : paneVoice ? `${paneVoice}…` : paneSession.kind === 'ssh' ? 'ssh' : 'bash'}
                      <button
                        type="button"
                        className={paneVoice ? `pane-mic ${paneVoice}` : 'pane-mic'}
                        onClick={() => void toggleVoice(paneSession)}
                        disabled={voice.status !== 'idle' && !paneVoice}
                        title={paneVoice === 'listening' ? 'Stop and transcribe' : paneVoice === 'transcribing' ? 'Transcribing…' : 'Voice input'}
                        aria-label={paneVoice === 'listening' ? `Stop recording ${paneSession.name}` : `Voice input for ${paneSession.name}`}
                      >
                        <Icon name="mic" />
                      </button>
                      <button type="button" className="pane-maximize" onClick={() => toggleMaximize(paneSession.id)} title={maximizedPaneId ? 'Restore pane' : 'Maximize pane'}>
                        <Icon name={maximizedPaneId ? 'restore' : 'maximize'} />
                      </button>
                      <button type="button" className="pane-close" onClick={() => void closePane(paneSession)} title="Close pane" aria-label={`Close ${paneSession.name}`}>
                        <Icon name="x" />
                      </button>
                    </span>
                  </div>
                  <TerminalView
                    sessionId={paneSession.id}
                    focused={focusedSessionId === paneSession.id}
                    onStatus={setStatus}
                    appearance={settings.appearance}
                    terminalSettings={settings.terminal}
                    registerFocus={registerTerminalFocus}
                  />
                </article>
              );
            })}
          </div>

          <footer className="status-bar">
            <span>ZeroG</span>
            <span className="status-separator" />
            <span>{activeWorkspace?.name ?? 'Workspace'}</span>
            <span className="status-separator" />
            <span>{maximizedPaneId ? 'maximized pane' : layout === 'stack' ? '1 pane' : `${paneCount} panes`}</span>
            <span className="status-separator" />
            <span>Esc closes overlays · ⌘⇧B sidebar</span>
            <span className="status-spacer" />
            <span>{active ? `${active.kind === 'ssh' ? 'SSH' : active.persistence === 'process' ? 'PROCESS' : 'SCREEN'} · ${active.persistence === 'process' ? 'non-persistent' : 'persistent'}` : 'no connection'}</span>
          </footer>
        </section>
      </div>

      {overview && (
        <div className="overview-layer" role="presentation" {...dismissOverview}>
          <section className="overview">
            <div className="overview-head">
              <div>
                <span className="eyebrow">WORKSPACE OVERVIEW</span>
                <h2>{activeWorkspace?.name ?? 'Choose a session'}</h2>
              </div>
              <button type="button" className="close-button" onClick={() => setOverview(false)}>Esc</button>
            </div>
            <div className="thumbnail-grid">
              {workspaceSessions.length ? (
                workspaceSessions.map((session) => (
                  <button
                    type="button"
                    className={`thumbnail ${active?.id === session.id ? 'active' : ''}`}
                    key={session.id}
                    onClick={() => void attach(session)}
                  >
                    <div className="thumbnail-preview">
                      <span className="thumbnail-line cyan" />
                      <span className="thumbnail-line short" />
                      <span className="thumbnail-line green" />
                      <span className="thumbnail-cursor" />
                    </div>
                    <div className="thumbnail-label">
                      <b>{session.name}</b>
                      <small>{session.kind === 'ssh' ? session.host : 'local screen'} · {session.status}</small>
                    </div>
                  </button>
                ))
              ) : (
                <div className="overview-empty">
                  <span>▦</span>
                  <b>No terminals in this workspace</b>
                  <small>Create a local terminal or connect over SSH.</small>
                </div>
              )}
            </div>
            <div className="overview-foot">
              <button type="button" onClick={() => { setOverview(false); openNewLocalTerminal(); }}>+ Local terminal</button>
              <button type="button" onClick={() => { setOverview(false); openSessionDialog('ssh'); }}>Connect SSH</button>
              <button type="button" onClick={() => { setOverview(false); openNewWorkspace(); }}>+ Workspace</button>
              <span className="overview-hint">Press Esc to close</span>
            </div>
          </section>
        </div>
      )}

      {/* The history backdrop is decorative: dismissal is also available on
          Escape and the close button, so it carries no keyboard handler of its
          own. Closing only on a press that started on the backdrop removes the
          need for the popover to stop propagation, which was a click handler on
          a non-interactive dialog element. */}
      {historyOpen && (
        <div className="history-layer" role="presentation" {...dismissHistory}>
          <div className="history-popover" role="dialog" aria-label="Session history">
          <div className="history-head"><b>History</b><button type="button" onClick={() => setHistoryOpen(false)} aria-label="Close history">×</button></div>
          {historyEntries.length ? historyEntries.slice().sort((a, b) => b.timestamp.localeCompare(a.timestamp)).map((entry) => (
            <button type="button" className="history-item" key={entry.id} onClick={async () => {
              setHistoryOpen(false);
              const hasScreen = !!entry.session.screenName;
              const isPlainSsh = entry.session.kind === 'ssh' && !hasScreen;
              if (hasScreen || entry.session.backend === 'screen') {
                setSidebarTab('screens');
                const screenSource = entry.session.screenName || entry.session.name;
                const remoteMatch = sessions.find((s) => s.kind === 'ssh' && s.screenName === screenSource);
                const localMatch = sessions.find((s) => s.screenName === screenSource && s.kind === 'local');
                if (remoteMatch) {
                  claimSession(remoteMatch);
                  await attach(remoteMatch);
                  setStatus(`Reconnecting to ${remoteMatch.name}…`);
                  return;
                }
                if (localMatch) {
                  claimSession(localMatch);
                  await attach(localMatch);
                  setStatus(`Reconnecting to ${localMatch.name}…`);
                  return;
                }
                const currentApi = api();
                if (!currentApi) return;
                const known = knownConnections.find((c) => (entry.session.host || '').includes(c.hostName || c.alias) || (c.hostName || c.alias).includes(entry.session.host || ''));
                if (known) {
                  await attachRemoteScreen({ ...entry.session, screenName: screenSource, host: known.hostName || known.alias } as any, known);
                  return;
                }
                if (entry.session.host) {
                  const target = entry.session.host;
                  const newSession = await currentApi.createSshSession({ target, name: entry.session.name });
                  setSessions((current) => [...current, newSession]);
                  claimSession(newSession);
                  setFocusedSessionId(newSession.id);
                  setMaximizedSessionId(null);
                  setLayout(layoutForSessionCount(workspaceSessions.length + 1));
                  await attach(newSession);
                  const screenSource = entry.session.screenName || entry.session.name;
                  currentApi.write(newSession.id, `screen -x ${screenSource}\r`);
                  setStatus(`Connected to ${newSession.name}`);
                }
                return;
              }
              if (isPlainSsh) {
                const target = entry.session.host || entry.session.sshTarget || '';
                const defaultName = target.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 40);
                setSshTarget(target);
                setSshName(entry.session.name && entry.session.name !== defaultName ? entry.session.name : '');
                const currentApi = api();
                if (!currentApi) return;
                const connection = knownConnections.find((c) => (target.includes(c.hostName || c.alias) || (c.hostName || c.alias).includes(target)));
                const fallbackName = entry.session.name || defaultName;
                const ssh = await currentApi.createSshSession({ target, name: fallbackName });
                setSessions((current) => [...current, ssh]);
                claimSession(ssh);
                await attach(ssh);
                setStatus(`Connected to ${ssh.name}`);
                if (currentApi.discoverRemoteScreens && connection) {
                  try {
                    const remote = await currentApi.discoverRemoteScreens(connection);
                    if (remote.length) {
                      const screen = remote.find((s) => s.status === 'detached') ?? remote[0];
                      await attachRemoteScreen(screen, connection);
                      return;
                    }
                  } catch {
                    // keep the SSH session even if remote screen discovery fails.
                  }
                }
                return;
              }
              setSidebarTab('terminals');
            }}>
              <span className="history-main">
                <span className="history-kind">{entry.event.toUpperCase()}</span>
                <span className="history-text"><b>{entry.session.name}</b><small>{entry.session.host} · {entry.available ? 'available' : 'unavailable'}</small></span>
              </span>
              <button type="button" className="history-remove" aria-label="Remove history entry" onClick={(event) => { event.stopPropagation(); void api()?.removeHistory(entry.id).then(() => setHistoryEntries((current) => current.filter((item) => item.id !== entry.id))).catch(() => {}); }}>×</button>
            </button>
          )) : <p className="history-empty">No history entries yet.</p>}
          <small className="history-note">Persisted session lifecycle from the main process.</small>
          </div>
        </div>
      )}

      {modal && (
        <div className="modal-layer" role="presentation" {...dismissModal}>
          <form
            className="modal-card"
            onSubmit={modal === 'workspace' ? createWorkspace : modal === 'local' ? createLocal : createSsh}
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow">{dialogCopy(modal).eyebrow}</span>
                <h2>{dialogCopy(modal).title}</h2>
              </div>
              <button type="button" className="close-button" onClick={() => setModal(null)}>Esc</button>
            </div>

            {isSessionDialogKind(modal) && (
              // A tablist is one tab stop: the arrows move between the tabs, so
              // the fields stay one Tab press from the heading.
              <div className="dialog-tabs" role="tablist" aria-label="Session type">
                {SESSION_TABS.map((tab) => (
                  <button
                    type="button"
                    key={tab.kind}
                    id={`session-tab-${tab.kind}`}
                    role="tab"
                    aria-selected={modal === tab.kind}
                    aria-controls="session-dialog-panel"
                    tabIndex={modal === tab.kind ? 0 : -1}
                    // Switching mid-create would submit one kind and show the other.
                    disabled={busy}
                    className={`dialog-tab ${modal === tab.kind ? 'active' : ''}`}
                    onClick={() => setModal(tab.kind)}
                    onKeyDown={(event) => {
                      const next = nextSessionTab(tab.kind, event.key);
                      if (!next) return;
                      event.preventDefault();
                      setModal(next);
                      // Selection and focus move together in a tablist.
                      document.getElementById(`session-tab-${next}`)?.focus();
                    }}
                  >
                    <b>{tab.label}</b>
                    <small>{tab.hint}</small>
                  </button>
                ))}
              </div>
            )}

            {modal === 'workspace' && (
              <>
                <p>Create a separate workspace for a project or host group. Terminals stay scoped to the active workspace.</p>
                <label>
                  Workspace name
                  <input
                    autoFocus
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    pattern="[A-Za-z0-9](?:[A-Za-z0-9_.]|-| ){0,48}"
                    required
                  />
                </label>
              </>
            )}

            {isSessionDialogKind(modal) && (
              <div id="session-dialog-panel" role="tabpanel" aria-labelledby={`session-tab-${modal}`}>
                {modal === 'local' && (
                  <>
                    <p>Start a local session inside “{activeWorkspace?.name ?? 'this workspace'}”.</p>
                    <label>
                      Terminal name
                      <input
                        autoFocus
                        value={localName}
                        onChange={(event) => setLocalName(event.target.value)}
                        pattern="[A-Za-z0-9](?:[A-Za-z0-9_.]|-){0,48}"
                        required
                      />
                    </label>
                    <label>
                      Shell backend
                      <select value={selectedBackend} onChange={(event) => { const value = event.target.value as LocalBackend; setSelectedBackend(value); }}>
                        {localBackends.length ? localBackends.map((item) => <option key={item.backend} value={item.backend}>{item.label}</option>) : <option value="bash">bash</option>}
                      </select>
                    </label>
                    {selectedBackend === 'wsl' && (
                      <label>
                        WSL distribution
                        <input value={wslDistribution} onChange={(event) => setWslDistribution(event.target.value)} placeholder="Ubuntu" />
                      </label>
                    )}
                  </>
                )}

                {modal === 'ssh' && (
                  <>
                    <p>Connect a remote host into “{activeWorkspace?.name ?? 'this workspace'}”.</p>
                    <label>
                      SSH target
                      <input
                        autoFocus
                        value={sshTarget}
                        onChange={(event) => setSshTarget(event.target.value)}
                        placeholder="user@server:22"
                        required
                      />
                    </label>
                    <label>
                      Session label <span className="muted-text">optional</span>
                      <input value={sshName} onChange={(event) => setSshName(event.target.value)} placeholder="server" />
                    </label>
                  </>
                )}
              </div>
            )}

            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>Cancel</button>
              <button className="primary-button" disabled={busy} type="submit">
                {busy ? 'Working…' : dialogCopy(modal).submit}
              </button>
            </div>
          </form>
        </div>
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={changeSetting}
          onReset={resetSettings}
          onClose={() => setSettingsOpen(false)}
          backdrop={dismissSettings}
          backends={localBackends}
          wslDistributions={wslDistributions}
          speechTest={speechTest}
          onSpeechTest={() => void runSpeechTest()}
        />
      )}

      {voiceReview && (
        <div className="modal-layer" role="presentation" {...dismissVoiceReview}>
          <div className="modal-card approval-card">
            <div className="modal-head">
              <div>
                <span className="eyebrow">VOICE</span>
                <h2>Insert transcript?</h2>
              </div>
              <button type="button" className="close-button" onClick={() => closeVoiceReview()}>Esc</button>
            </div>
            <p>Review mode is on, so nothing has been typed yet. Inserting does not press Enter.</p>
            <code>{voiceReview.text}</code>
            <div className="modal-actions">
              <button type="button" onClick={() => closeVoiceReview()}>Discard</button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  api()?.write(voiceReview.sessionId, voiceReview.text);
                  setStatus(`Voice: "${voiceReview.text}"`);
                  closeVoiceReview();
                }}
              >
                Insert
              </button>
            </div>
          </div>
        </div>
      )}

      {approval && (
        <div className="modal-layer" role="presentation" {...dismissApproval}>
          <div className="modal-card approval-card">
            <div className="modal-head">
              <div>
                <span className="eyebrow warning-text">APPROVAL REQUIRED</span>
                <h2>Run suggestion?</h2>
              </div>
              <button type="button" className="close-button" onClick={() => setApproval(null)}>Esc</button>
            </div>
            <p>{approval.explanation}</p>
            <code>{approval.command}</code>
            <div className="modal-actions">
              <button type="button" onClick={() => setApproval(null)}>Cancel</button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  if (active) api()?.write(active.id, `${approval.command}\r`);
                  setApproval(null);
                }}
              >
                Approve & run
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function terminalTheme(theme: Theme) {
  return theme === 'light'
    ? {
        background: '#f7f9fc',
        foreground: '#253044',
        cursor: '#16803c',
        selectionBackground: '#cbdcf5',
        green: '#16803c',
        yellow: '#a15c00',
        red: '#c53030',
        blue: '#2459a6',
        cyan: '#087f8c'
      }
    : {
        background: '#0a0c10',
        foreground: '#d8dee9',
        cursor: '#9ece6a',
        selectionBackground: '#334155',
        green: '#9ece6a',
        yellow: '#e0af68',
        red: '#f7768e',
        blue: '#7aa2f7',
        cyan: '#7dcfff'
      };
}

function nextWorkspaceName(workspaces: Workspace[]): string {
  let index = workspaces.length + 1;
  const names = new Set(workspaces.map((item) => item.name.toLowerCase()));
  while (names.has(`workspace ${index}`)) index += 1;
  return `Workspace ${index}`;
}

function nextTerminalName(workspaceName: string, sessions: SessionInfo[]): string {
  const base = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'term';
  const names = new Set(sessions.map((session) => session.name.toLowerCase()));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function layoutForSessionCount(count: number): Layout {
  if (count <= 1) return 'stack';
  if (count === 2) return 'split-v';
  return 'grid';
}

createRoot(document.getElementById('root')!).render(<App />);
