import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import type { ForwardBind, ForwardDirection, HistoryEntry, KnownConnection, PortForwardInfo, SessionInfo, ShellBackend, StoredWorkspaceMember, TerminalApi } from '../shared/types';
import { VoiceRecorder, isMostlySilence, rootMeanSquare } from './voice';
import { looksLikeShellPrompt, normalizeHost } from './remote-screens';
import { attachTerminalClipboard } from './terminal-clipboard';
import { useBackdropDismiss } from './backdrop-dismiss';
import { useRowActivation } from './row-activation';
import {
  WORKSPACE_NAME_PATTERN,
  adoptLiveSessions,
  claimInto,
  closeWorkspace,
  dropPending,
  fromStoredFile,
  isWorkspaceName,
  layoutForSessionCount,
  makeView,
  makeWorkspace,
  nextWorkspaceName,
  reconcileWorkspaces,
  releaseSession,
  renameWorkspace,
  toStoredFile,
  updateView,
  workspaceDotState,
  workspacePaneCount,
  paneEntries,
  type Workspace,
  type WorkspaceView
} from './workspace-view';
import { planSessionRestore, type RestoreAction, type SessionDescriptor } from './session-restore';
import {
  applyForwardStatus,
  forwardConflict,
  forwardDotState,
  forwardLabel,
  fromStoredForwards,
  groupForwards,
  isWidelyBound,
  listenerLabel,
  toStoredForwards
} from './port-forwards';
import { Icon } from './icons';
import { CWD_BUFFER_CHARS, readCwd } from './cwd-tracker';
import { SftpPanel } from './sftp-panel';
import { sftpTargetForSession, transferAvailability } from './sftp-view';
import {
  DEFAULT_SETTINGS,
  SETTING_LIMITS,
  backendLabel,
  fontStack,
  loadSettings,
  resetSection,
  resolveDefaultBackend,
  resolveProceedPhrase,
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
import { SettingsPanel, type AiTestState, type SpeechKeyState, type SpeechTestState } from './settings-panel';
import { SESSION_TABS, dialogCopy, isSessionDialogKind, nextSessionTab, type SessionDialogKind } from './session-dialog';
import {
  SPLIT_BUTTONS,
  singlePaneAction,
  singlePaneTitle,
  splitButtonAction,
  splitButtonTitle,
  type PaneAction,
  type PaneView
} from './pane-layout';
import { SpeechClient, type SpeechWorker } from './speech';
import { askSuggestion, boundedTail, canAutoRun, isConfigured, type SuggestPhase } from './ai-suggest';

/** Settle once output has been quiet this long — the primary readiness signal. */
const PROMPT_QUIET_MS = 150;
/** Give up waiting and send anyway; matches the previous unconditional delay's role. */
const PROMPT_WAIT_CAP_MS = 3000;
/** Enough tail to hold a prompt spanning several chunks, without growing forever. */
const PROMPT_BUFFER_CHARS = 512;
/**
 * How long the workspace layout must hold still before it is written to disk.
 *
 * Long enough to swallow a burst of pane switches or a divider drag, short
 * enough that quitting straight after a change still saves it.
 */
const WORKSPACE_SAVE_DEBOUNCE_MS = 400;

/**
 * The message a main-process error actually carries.
 *
 * Electron wraps a rejected ipcMain handler as "Error invoking remote method
 * 'channel': Error: …", which buries a sentence written for the user behind two
 * layers of plumbing they have no use for. The main process takes trouble over
 * those sentences — "Port 3000 is already shared from build.example.com", "Could
 * not reach http://…/v1/chat/completions. Is the server running?" — and they are
 * worth showing as written.
 */
function ipcMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Error|TypeError):\s*/, '');
}

/** A stored pane as the restore planner wants it. */
function memberDescriptor(member: StoredWorkspaceMember): SessionDescriptor {
  return {
    id: member.sessionId,
    name: member.name,
    kind: member.kind,
    host: member.host,
    screenName: member.screenName,
    sshTarget: member.sshTarget,
    backend: member.backend
  };
}

type VoiceStatus = 'idle' | 'listening' | 'transcribing';

type ModalKind = 'workspace' | 'local' | 'ssh' | 'forward' | null;
type SidebarTab = 'terminals' | 'screens' | 'connections';
/** Which thing the sidebar is a list of. Ports are their own view, not a tab. */
type SidebarView = 'sessions' | 'ports';

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

/**
 * A pane a workspace remembers from a previous launch but has not reopened.
 *
 * Reads as a session row so it keeps its place in the workspace's list, and is
 * ghosted so it is never mistaken for a running terminal. Clicking it is the
 * consent to reconnect — an SSH pane must not dial out to a host on startup.
 */
function PendingPaneRow({ member, onClick }: { member: StoredWorkspaceMember; onClick: () => void }) {
  const detail = member.kind === 'ssh'
    ? `SSH · ${member.host ?? member.sshTarget ?? 'saved host'}`
    : member.screenName
      ? `screen · ${member.screenName}`
      : 'local';
  return (
    <button type="button" className="session-row session-ghosted" title={`Reconnect ${member.name}`} onClick={onClick}>
      <span className="status-dot" />
      <span className="session-copy"><b>{member.name}</b><small>{detail} · not connected</small></span>
      <span className="session-state">↻</span>
    </button>
  );
}

/**
 * A saved SSH connection in the sidebar's Connections tab.
 *
 * Click opens the connect dialog with the host filled in, for when the target
 * or the pane's label wants editing. Double-click skips the dialog and puts the
 * host straight into a new pane — the common case for a connection whose
 * ~/.ssh/config entry already says everything ssh needs.
 */
function ConnectionRow({ connection, onConfigure, onConnect }: { connection: KnownConnection; onConfigure: () => void; onConnect: () => void }) {
  const activation = useRowActivation(onConfigure, onConnect);
  const detail = connection.hostName
    ? `${connection.user ?? ''}${connection.user ? '@' : ''}${connection.hostName}${connection.port ? `:${connection.port}` : ''}`
    : 'Saved SSH connection';
  return (
    <button
      type="button"
      className="session-row"
      title={`Double-click to connect ${connection.alias} in a new pane`}
      onClick={activation.onClick}
      onDoubleClick={activation.onDoubleClick}
    >
      <span className="status-dot" />
      <span className="session-copy"><b>{connection.alias}</b><small>{detail}</small></span>
      <span className="session-state">→</span>
    </button>
  );
}

/**
 * What a pane is showing, as plain text.
 *
 * Walks xterm's buffer rather than accumulating output as it arrives: the buffer
 * is already the wrapped, overwritten, cursor-addressed result, which is what
 * the user is looking at. A rolling copy of the raw stream would include frames
 * that were painted over and escape sequences that never rendered.
 *
 * translateToString already yields plain text, so nothing needs stripping. Only
 * the tail is read — a scrollback of 200,000 lines is not worth walking to throw
 * most of it away.
 */
function readTerminalText(terminal: Terminal | null, maxLines = 200): string {
  if (!terminal) return '';
  const buffer = terminal.buffer.active;
  const end = buffer.length;
  const start = Math.max(0, end - maxLines);
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
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
  dormant = false,
  onStatus,
  appearance,
  terminalSettings,
  registerFocus,
  registerRead
}: {
  sessionId?: string;
  focused?: boolean;
  /** This pane's workspace is not on screen: mounted and live, but unpainted. */
  dormant?: boolean;
  onStatus: (message: string) => void;
  appearance: AppearanceSettings;
  terminalSettings: TerminalSettings;
  /** Lets the app put the keyboard back in this pane after a control took it. */
  registerFocus?: (sessionId: string, focus: (() => void) | null) => void;
  /**
   * Lets the app read what this pane is showing, for an AI suggestion.
   *
   * A registration rather than a prop of content, because the buffer is xterm's
   * and copying it on every render would be absurd — the app asks at the one
   * moment it needs to.
   */
  registerRead?: (sessionId: string, read: (() => string) | null) => void;
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
      // Send a clicked link to the desktop browser.
      //
      // Without this, xterm's own handler asks for confirmation and then calls
      // window.open — which Electron answers with a window of this application,
      // so a link opened in something that is not the user's browser. The main
      // process refuses that anyway (see setWindowOpenHandler), but going
      // through openExternal directly is what makes a click do the right thing
      // rather than merely not do the wrong one.
      linkHandler: {
        activate: (_event, uri) => {
          const currentApi = api();
          if (!currentApi?.openExternal) return;
          statusRef.current(`Opening ${uri}`);
          void currentApi.openExternal(uri).catch((error: unknown) => {
            statusRef.current(error instanceof Error ? error.message : String(error));
          });
        },
        // OSC 8 lets a remote host label a link with text that has nothing to do
        // with where it goes, so showing the real target on hover is the only
        // point at which the user can tell. This is what VS Code's terminal and
        // Windows Terminal both do.
        hover: (_event, uri) => statusRef.current(`Link: ${uri}`),
        leave: () => statusRef.current('Ready')
      },
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

  /**
   * Repaint a pane that has just come back on screen.
   *
   * A dormant pane is `display: none`, so it has no box and xterm's renderer has
   * had nothing to draw into. Refitting alone does not fix that: if the pane
   * returns at the size it left, xterm's own resize is a no-op and the renderer
   * is never asked to paint, which is why a returning workspace showed empty
   * panes until something changed their size. refresh() marks every row dirty
   * and is the only thing that reliably puts the existing buffer back on screen.
   */
  useEffect(() => {
    if (dormant) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    refitRef.current?.();
    // After the browser has given the pane a box again, or there is still
    // nothing to measure against.
    const frame = requestAnimationFrame(() => {
      if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [dormant]);

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

  useEffect(() => {
    if (!sessionId || !registerRead) return;
    registerRead(sessionId, () => readTerminalText(terminalRef.current));
    return () => registerRead(sessionId, null);
  }, [sessionId, registerRead]);

  return (
    <div className="terminal" ref={ref} onMouseDownCapture={(event) => event.preventDefault()} />
  );
}

/**
 * A divider the user can drag to resize what sits either side of it.
 *
 * Pointer capture rather than window listeners: the pointer leaves this strip on
 * the first frame of any real drag, and capture keeps the events arriving here
 * without a listener that could outlive the gesture. Dragging reports a
 * position; the caller turns that into a width or a ratio, since only it knows
 * what its own container measures.
 *
 * Keyboard-operable as well as draggable, per the project's rule that a mouse
 * control has an equivalent: it takes focus, the arrow keys nudge it, and Enter
 * or a double-click puts it back where it started.
 */
function ResizeHandle({
  orientation,
  className,
  label,
  valuePercent,
  style,
  onDrag,
  onCommit,
  onNudge,
  onReset
}: {
  /** The handle's own direction: vertical divides left from right. */
  orientation: 'vertical' | 'horizontal';
  className: string;
  label: string;
  /** Reported to assistive tech as the share taken by the side before it. */
  valuePercent: number;
  style?: React.CSSProperties;
  onDrag: (position: { clientX: number; clientY: number }) => void;
  onCommit: () => void;
  onNudge: (direction: -1 | 1) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const back = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
  const forward = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(valuePercent)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      className={`${className} ${dragging ? 'dragging' : ''}`.trim()}
      style={style}
      title={`${label} — drag, arrow keys, or double-click to reset`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Without this the browser starts a text selection across both panes.
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onDrag(event);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        onCommit();
      }}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === back) {
          event.preventDefault();
          onNudge(-1);
        } else if (event.key === forward) {
          event.preventDefault();
          onNudge(1);
        } else if (event.key === 'Enter' || event.key === 'Home') {
          event.preventDefault();
          onReset();
        }
      }}
    />
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

function App() {
  // Read once, synchronously, so the first paint already uses the stored theme
  // and font instead of flashing the defaults.
  const [settings, setSettings] = useState<Settings>(() => loadSettings(browserStorage()));
  const theme: Theme = settings.appearance.theme;
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => [
    makeWorkspace('Workspace', settings.sessions.defaultLayout)
  ]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => workspaces[0]?.id ?? '');
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [drawerCollapsed, setDrawerCollapsed] = useState(settings.sessions.startSidebarCollapsed);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('terminals');
  const [sidebarView, setSidebarView] = useState<SidebarView>('sessions');
  const [forwards, setForwards] = useState<PortForwardInfo[]>([]);
  const [forwardsLoaded, setForwardsLoaded] = useState(false);
  const [forwardPrompt, setForwardPrompt] = useState<{ forwardId: string; kind: string; text: string } | null>(null);
  const [forwardTarget, setForwardTarget] = useState('');
  const [forwardDirection, setForwardDirection] = useState<ForwardDirection>('local');
  const [forwardBind, setForwardBind] = useState<ForwardBind>('loopback');
  const [forwardListenPort, setForwardListenPort] = useState('');
  const [forwardDestinationPort, setForwardDestinationPort] = useState('');
  const [forwardDestinationHost, setForwardDestinationHost] = useState('');
  const [forwardAdvanced, setForwardAdvanced] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [overview, setOverview] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('Workspace');
  const [renamingWorkspace, setRenamingWorkspace] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  // Nothing may be saved until the stored file has been read, or the empty
  // starting state would be written over it on the first render.
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [visitedWorkspaces, setVisitedWorkspaces] = useState<string[]>([]);
  const [localName, setLocalName] = useState('term');
  const [sshName, setSshName] = useState('');
  const [sshTarget, setSshTarget] = useState('');
  const [suggest, setSuggest] = useState<SuggestPhase | null>(null);
  const [aiKey, setAiKey] = useState<SpeechKeyState>({ status: 'idle', stored: false, encryptionAvailable: true, sessionOnly: false });
  const [aiModels, setAiModels] = useState<string[]>([]);
  const [aiTest, setAiTest] = useState<AiTestState>({ status: 'idle' });
  const [voice, setVoice] = useState<{ status: VoiceStatus; sessionId: string | null }>({ status: 'idle', sessionId: null });
  const [voiceReview, setVoiceReview] = useState<{ sessionId: string; text: string } | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const speechRef = useRef<SpeechClient | null>(null);
  const voiceTargetRef = useRef<string | null>(null);
  const voiceLimitRef = useRef<number | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [speechTest, setSpeechTest] = useState<SpeechTestState>({ status: 'idle' });
  const speechTestRecorderRef = useRef<VoiceRecorder | null>(null);
  const speechTestLimitRef = useRef<number | undefined>(undefined);
  const [speechKey, setSpeechKey] = useState<SpeechKeyState>({ status: 'idle', stored: false, encryptionAvailable: true, sessionOnly: false });
  /**
   * A key this system could not encrypt, held until the app closes.
   *
   * A ref, not state: it is read when a request is being built, and putting a
   * key in React state would put it in every render's closure for no reason.
   */
  const sessionSpeechKeyRef = useRef<string | null>(null);
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
  // What each pane is showing, for a suggestion that includes output. Registered
  // the same way focus is, and read only at the moment a request is made.
  const terminalReadRef = useRef(new Map<string, () => string>());
  const registerTerminalRead = useCallback((sessionId: string, read: (() => string) | null) => {
    if (read) terminalReadRef.current.set(sessionId, read);
    else terminalReadRef.current.delete(sessionId);
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
  const dismissSuggest = useBackdropDismiss(() => {
    void api()?.cancelAiRequest?.();
    setSuggest(null);
  });
  const dismissOverview = useBackdropDismiss(() => setOverview(false));
  const dismissHistory = useBackdropDismiss(() => setHistoryOpen(false));
  const dismissSettings = useBackdropDismiss(() => setSettingsOpen(false));
  const dismissVoiceReview = useBackdropDismiss(() => closeVoiceReview());
  const dismissTransfer = useBackdropDismiss(() => setTransferOpen(false));

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

  /**
   * The same edit, without writing it to storage.
   *
   * For a value being dragged: localStorage is synchronous, and saving the whole
   * settings object on every pointermove puts a write in the middle of a resize.
   * The gesture ends with changeSetting, which persists the size it settled on.
   */
  const changeSettingLive = useCallback(<K extends SettingsSection>(section: K, patch: Partial<Settings[K]>) => {
    setSettings((current) => updateSection(current, section, patch));
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

  // Layout, selection, focus, and maximize belong to the workspace, not to the
  // app: switching away and back has to find the arrangement you left. They are
  // read out here and written through the small setters below so that the rest
  // of this component still reads as though they were plain state.
  const view: WorkspaceView = activeWorkspace?.view ?? makeView(settings.sessions.defaultLayout);
  const layout = view.layout;
  const focusedSessionId = view.focusedSessionId;
  const maximizedSessionId = view.maximizedSessionId ?? null;

  /**
   * The selected session, looked up rather than stored.
   *
   * Holding the whole SessionInfo in state meant every status, cwd, or
   * persistence change had to be copied into it as well, and anything read off
   * the copy — the status bar, the transfer panel's target — could be a step
   * behind the sidebar.
   */
  const active = useMemo(
    () => (view.activeSessionId ? sessions.find((item) => item.id === view.activeSessionId) ?? null : null),
    [view.activeSessionId, sessions]
  );

  const patchView = useCallback(
    (patch: Partial<WorkspaceView> | ((current: WorkspaceView) => Partial<WorkspaceView>), workspaceId?: string) => {
      setWorkspaces((current) => updateView(current, workspaceId ?? activeWorkspaceId, patch));
    },
    [activeWorkspaceId]
  );

  const setActive = useCallback(
    (session: SessionInfo | null) => patchView({ activeSessionId: session?.id }),
    [patchView]
  );
  const setLayout = useCallback(
    (value: Layout | ((current: Layout) => Layout)) =>
      patchView((current) => ({ layout: typeof value === 'function' ? value(current.layout) : value })),
    [patchView]
  );
  const setFocusedSessionId = useCallback(
    (sessionId?: string) => patchView({ focusedSessionId: sessionId }),
    [patchView]
  );
  const setMaximizedSessionId = useCallback(
    (sessionId: string | null) => patchView({ maximizedSessionId: sessionId }),
    [patchView]
  );

  /**
   * The sessions this workspace holds — only the ones it actually claimed.
   *
   * A discovered `screen` session or a known SSH connection is global
   * inventory, not a member of whichever workspace happens to be open when it
   * is found; attaching one is what claims it. The first workspace used to
   * absorb everything unassigned, which made its Terminals tab a dumping ground
   * for other projects' shells and could push it past the four-pane cap on its
   * own. Unclaimed screens now stay in the Screens tab, whose filter already
   * excludes workspace members, so nothing becomes unreachable.
   */
  const workspaceSessions = useMemo(() => {
    if (!activeWorkspace) return sessions;
    const known = new Set(activeWorkspace.sessionIds);
    return sessions.filter((session) => known.has(session.id));
  }, [activeWorkspace, sessions]);

  /** Panes this workspace remembers from a previous launch, still to reconnect. */
  const pendingPanes = activeWorkspace?.pending ?? [];

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

  // Whether a speech key is saved is the main process's answer, not something
  // the renderer remembers: asked once here so the settings panel opens with
  // the truth rather than a guess.
  useEffect(() => {
    const currentApi = api();
    if (!currentApi?.speechApiKeyStatus) return;
    currentApi
      .speechApiKeyStatus()
      .then((status) => setSpeechKey((previous) => ({ ...previous, stored: status.stored, encryptionAvailable: status.encryptionAvailable })))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const currentApi = api();
    if (!currentApi?.aiApiKeyStatus) return;
    currentApi
      .aiApiKeyStatus()
      .then((status) => setAiKey((previous) => ({ ...previous, stored: status.stored, encryptionAvailable: status.encryptionAvailable })))
      .catch(() => undefined);
  }, []);

  /**
   * Drop session ids the workspaces still name but that no longer exist.
   *
   * A `screen` session killed from another terminal, or one closed while a
   * different workspace was on screen, leaves a dangling id behind. Left there
   * it counts towards the four-pane cap and makes the tab dot claim a workspace
   * has contents it cannot show. reconcileWorkspaces returns the same array
   * when there is nothing to drop, so this settles in one pass.
   */
  useEffect(() => {
    if (sessionsLoading || !workspacesLoaded) return;
    setWorkspaces((current) => reconcileWorkspaces(current, sessions));
  }, [sessions, sessionsLoading, workspacesLoaded]);

  /**
   * Read the stored workspaces back, once, before anything can overwrite them.
   *
   * A failure here is not fatal: the app keeps the default single workspace and
   * carries on, and the save effect below is held off until this has finished so
   * an empty starting state cannot be written over a good file.
   */
  useEffect(() => {
    const currentApi = api();
    if (!currentApi?.loadWorkspaces) {
      setWorkspacesLoaded(true);
      return;
    }
    let cancelled = false;
    currentApi
      .loadWorkspaces()
      .then((file) => {
        if (cancelled) return;
        const restored = fromStoredFile(file, settings.sessions.defaultLayout);
        if (restored.workspaces.length) {
          setWorkspaces(restored.workspaces);
          if (restored.activeWorkspaceId) setActiveWorkspaceId(restored.activeWorkspaceId);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setWorkspacesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Take over remembered panes whose sessions turn out to be running.
   *
   * Runs on every session-list change, not just at startup: a remote screen
   * discovered a few seconds in should be adopted by the workspace that was
   * waiting for it, rather than sitting as a ghost row beside the live session.
   * Only `attach` counts — anything that would have to dial out to a host waits
   * for the user to click.
   */
  useEffect(() => {
    if (sessionsLoading || !workspacesLoaded) return;
    setWorkspaces((current) =>
      adoptLiveSessions(current, (member) => {
        const action = planSessionRestore(memberDescriptor(member), sessions, knownConnections);
        return action.kind === 'attach' ? action.sessionId : undefined;
      })
    );
  }, [sessions, sessionsLoading, workspacesLoaded, knownConnections]);

  /**
   * Follow tunnels the main process is reporting on.
   *
   * A tunnel can change without this window asking — a host drops the
   * connection, sshd refuses a forward, the client wants a password — so the
   * list is driven by events rather than by what the open call returned.
   */
  useEffect(() => {
    const currentApi = api();
    if (!currentApi?.onForwardEvent) return;
    return currentApi.onForwardEvent((event) => {
      if (event.type === 'status') {
        setForwards((current) => applyForwardStatus(current, event.forward));
        return;
      }
      if (event.type === 'prompt') {
        setForwardPrompt({ forwardId: event.forwardId, kind: event.prompt.kind, text: event.prompt.text });
        return;
      }
      // Closed: leave the row in place if it is carrying an error, so the reason
      // survives long enough to be read.
      setForwards((current) =>
        current.map((forward) =>
          forward.id === event.forwardId && forward.status !== 'error'
            ? { ...forward, status: 'idle' as const }
            : forward
        )
      );
    });
  }, []);

  /**
   * Read remembered ports back, and adopt any tunnel already running.
   *
   * Nothing is reopened here. A restored row is idle until clicked, for the same
   * reason a restored SSH pane is: launching the app must not dial out to a host
   * on its own. Tunnels the main process already holds — this window was
   * reloaded, not restarted — are merged in with their real status.
   */
  useEffect(() => {
    const currentApi = api();
    if (!currentApi?.loadForwards) {
      setForwardsLoaded(true);
      return;
    }
    let cancelled = false;
    Promise.all([currentApi.loadForwards(), currentApi.listForwards?.() ?? []])
      .then(([file, live]) => {
        if (cancelled) return;
        const restored = fromStoredForwards(file);
        setForwards(live.reduce(applyForwardStatus, restored));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setForwardsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!forwardsLoaded) return;
    const currentApi = api();
    if (!currentApi?.saveForwards) return;
    const timer = setTimeout(() => {
      currentApi.saveForwards(toStoredForwards(forwards)).catch(() => {
        // Remembering a port must never interrupt the terminals.
      });
    }, WORKSPACE_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [forwards, forwardsLoaded]);

  /**
   * Save the layout after it settles.
   *
   * Debounced because the things it watches move in bursts — dragging a divider
   * or switching panes — and each save is a file write in the main process.
   */
  useEffect(() => {
    if (!workspacesLoaded || sessionsLoading) return;
    const currentApi = api();
    if (!currentApi?.saveWorkspaces) return;
    const timer = setTimeout(() => {
      currentApi.saveWorkspaces(toStoredFile(workspaces, activeWorkspaceId, sessions)).catch(() => {
        // Layout memory must never interrupt the terminals.
      });
    }, WORKSPACE_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [workspaces, activeWorkspaceId, sessions, workspacesLoaded, sessionsLoading]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    setVisitedWorkspaces((current) => (current.includes(activeWorkspaceId) ? current : [...current, activeWorkspaceId]));
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!active && workspaceSessions.length) {
      setActive(workspaceSessions[0]);
    }
  }, [active, workspaceSessions, setActive]);

  /**
   * Follow each session's working directory by reading its output.
   *
   * Two things want to know where a shell is: the breadcrumb above the panes,
   * which would otherwise show the directory the session was *created* in
   * forever, and the transfer panel, which opens the remote side there. Neither
   * is worth typing a `pwd` into the user's session for, so this listens for
   * what the shell says on its own — see cwd-tracker.ts.
   */
  // A link the main process would not open — a `file:` or an application scheme
  // from terminal output. The click has to say something, or it looks broken.
  useEffect(() => {
    const currentApi = api();
    return currentApi?.onLinkRefused?.((reason) => setStatus(reason));
  }, []);

  const cwdBuffers = useRef(new Map<string, string>());
  useEffect(() => {
    const currentApi = api();
    if (!currentApi) return;
    return currentApi.onData((sessionId, data) => {
      const buffer = ((cwdBuffers.current.get(sessionId) ?? '') + data).slice(-CWD_BUFFER_CHARS);
      cwdBuffers.current.set(sessionId, buffer);
      const reading = readCwd(buffer);
      if (!reading) return;
      // Returning the same array when nothing moved matters: this runs on every
      // chunk of terminal output, and a new array each time would re-render the
      // whole workspace while a build scrolls past.
      setSessions((current) => {
        const existing = current.find((item) => item.id === sessionId);
        if (!existing || existing.cwd === reading.path) return current;
        return current.map((item) => (item.id === sessionId ? { ...item, cwd: reading.path } : item));
      });
      // The selected session is looked up from `sessions`, so updating the list
      // is the whole job — there is no second copy to keep in step.
    });
  }, []);

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
        if (transferOpen) {
          event.preventDefault();
          setTransferOpen(false);
          return;
        }
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
        if (suggest) {
          event.preventDefault();
          // Abandon whatever is in flight: its answer would arrive against a
          // dialog that has gone.
          void api()?.cancelAiRequest?.();
          setSuggest(null);
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
      // App chrome, not the shell: a shortcut must not fire while the user is
      // typing into one of our own fields, such as the inline workspace rename.
      // xterm's input is a textarea, so a focused terminal is deliberately
      // still covered by these.
      if (event.target instanceof HTMLInputElement) return;
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
        patchView((current) => ({
          maximizedSessionId: null,
          layout: current.layout === 'stack' ? current.lastSplit : 'stack'
        }));
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
      // Same reason as the comma above: Shift+1 reports as '!', so the digit
      // only survives in event.code.
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit) {
        event.preventDefault();
        const target = workspaces[Number(digit[1]) - 1];
        if (target) switchWorkspace(target.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `sessions` is listed because the workspace-switch shortcut reads it to
    // pick the terminal to focus. It costs nothing: workspaceSessions already
    // changes with it, and setSessions returns the same array when nothing moved.
  }, [overview, suggest, modal, historyOpen, settingsOpen, transferOpen, voiceReview, voice.status, workspaces, activeWorkspaceId, activeWorkspace, workspaceSessions, sessions]);

  // Named here so the button's tooltip and its action cannot disagree about what
  // an emptied setting falls back to.
  const proceedPhrase = resolveProceedPhrase(settings.ai);
  // The host the transfer panel would talk to, and why the button is or is not
  // offered. Both come from the session the user is actually working in.
  const transferTarget = sftpTargetForSession(active);
  const transfer = transferAvailability(active);
  const paneCount = layout === 'stack' ? 1 : layout === 'grid' ? 4 : 2;

  /**
   * Workspaces whose panes are mounted.
   *
   * A workspace is not mounted until it has been shown once, because mounting a
   * pane attaches its session: rendering every workspace up front would start
   * every shell in every workspace on launch. Once visited it stays mounted, so
   * switching away no longer disposes its terminals. The active workspace is
   * always included, so the first frame after a switch already has its panes.
   */
  const mountedWorkspaceIds = useMemo(
    () => new Set([...visitedWorkspaces, activeWorkspaceId]),
    [visitedWorkspaces, activeWorkspaceId]
  );

  const allPanes = useMemo(
    () => paneEntries(workspaces.filter((workspace) => mountedWorkspaceIds.has(workspace.id)), sessions, activeWorkspaceId),
    [workspaces, sessions, activeWorkspaceId, mountedWorkspaceIds]
  );

  // Keep every workspace terminal mounted while changing layouts. Hiding a
  // pane must not dispose its xterm renderer and lose its scrollback/content.
  //
  // Taken from allPanes rather than filtered again, so that pane order and the
  // index the visibility rule counts against are the same list the grid renders.
  // Claim order is also the right order: it is the order panes were added, where
  // the session list's order is whatever the main process last reported.
  const paneSessions = useMemo(
    () => allPanes.filter((entry) => entry.workspaceId === activeWorkspaceId).map((entry) => entry.session),
    [allPanes, activeWorkspaceId]
  );
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

  useEffect(() => {
    // Selecting a local terminal takes the panel's host away from under it.
    if (transferOpen && !transferTarget) setTransferOpen(false);
  }, [transferOpen, transferTarget]);

  useEffect(() => {
    // Recorded from the layout rather than at each button, so a split reached
    // by any route is the one the single-pane view folds back out to. Per
    // workspace, so each one folds back to its own split.
    if (layout === 'stack' || view.lastSplit === layout) return;
    patchView({ lastSplit: layout });
  }, [layout, view.lastSplit, patchView]);

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
    setWorkspaces((current) => claimInto(current, workspaceId, session.id));
  };

  const createWorkspace = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = workspaceName.trim() || nextWorkspaceName(workspaces);
    const workspace = makeWorkspace(name, settings.sessions.defaultLayout);
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
    if ((activeWorkspace ? workspacePaneCount(activeWorkspace) : workspaceSessions.length) >= 4) {
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

  /**
   * Open an SSH session on `target` in a new pane of the active workspace.
   *
   * Shared by the connect dialog and the connections list: both need the same
   * four-pane cap, the same layout bump, and the same attach, and differ only
   * in where the target came from. The setModal(null) matters on the dialog
   * path and is a no-op on the other.
   */
  const connectSsh = async (
    target: string,
    name?: string,
    options?: {
      /**
       * Filling a pane the workspace already counts — a remembered one being
       * reconnected — rather than adding a new one. The cap must not refuse to
       * restore the fourth pane of a workspace that legitimately has four.
       */
      replacingPane?: boolean;
    }
  ): Promise<SessionInfo | null> => {
    const currentApi = api();
    if (!currentApi) return null;
    // The dialog's submit button is disabled while busy, but a sidebar row is
    // always clickable: two connects in flight would each read the pane count
    // from before the other, and between them could put five panes in a
    // workspace that holds four.
    if (busy) return null;
    const panes = activeWorkspace ? workspacePaneCount(activeWorkspace) : workspaceSessions.length;
    if (!options?.replacingPane && panes >= 4) {
      setStatus('This workspace supports up to 4 sessions.');
      setModal(null);
      return null;
    }
    setBusy(true);
    try {
      const session = await currentApi.createSshSession({ name: name || undefined, target });
      setSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
      claimSession(session);
      setFocusedSessionId(session.id);
      setMaximizedSessionId(null);
      setLayout(layoutForSessionCount(options?.replacingPane ? Math.max(panes, 1) : panes + 1));
      setModal(null);
      await attach(session);
      return session;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const createSsh = async (event: React.FormEvent) => {
    event.preventDefault();
    await connectSsh(sshTarget, sshName);
  };

  /**
   * Carry out what the restore planner decided.
   *
   * The history popover and a workspace's remembered panes both come through
   * here, so the two cannot drift into reconnecting the same shell differently.
   */
  const runRestoreAction = async (action: RestoreAction, options?: { replacingPane?: boolean }): Promise<SessionInfo | null> => {
    const currentApi = api();
    if (!currentApi) return null;

    if (action.kind === 'unavailable') {
      setStatus(action.reason);
      return null;
    }

    if (action.kind === 'attach') {
      const session = sessions.find((item) => item.id === action.sessionId);
      if (!session) return null;
      claimSession(session);
      await attach(session);
      return session;
    }

    if (action.kind === 'attach-remote-screen') {
      return attachRemoteScreen(action.name, action.screenName, action.connection);
    }

    const session = await connectSsh(action.target, action.name, options);
    if (!session || !action.screenCommand) return session;
    // The shell has to be ready before `screen -x` goes down the pipe, or the
    // command lands in a login banner and is lost.
    await currentApi.attachSession(session.id);
    await waitForShellPrompt(currentApi, session.id);
    currentApi.write(session.id, `${action.screenCommand}\r`);
    return session;
  };

  /**
   * Reconnect a pane the active workspace remembered from a previous launch.
   *
   * The remembered entry is dropped only once something came back, so a failed
   * reconnect — host down, key refused — leaves the ghost row in place to try
   * again rather than quietly shrinking the workspace.
   */
  const restorePendingPane = async (member: StoredWorkspaceMember) => {
    const action = planSessionRestore(memberDescriptor(member), sessions, knownConnections);
    if (action.kind === 'unavailable') {
      // Nothing to reconnect to: stop offering it, and say why.
      setWorkspaces((current) => dropPending(current, activeWorkspaceId, member.sessionId));
      setStatus(action.reason);
      return;
    }
    setStatus(`Reconnecting ${member.name}…`);
    const session = await runRestoreAction(action, { replacingPane: true });
    if (!session) return;
    setWorkspaces((current) => dropPending(current, activeWorkspaceId, member.sessionId));
  };

  /**
   * Connect a saved connection without going through the dialog.
   *
   * The target matches what the dialog would have been pre-filled with, so a
   * double-click and a click-then-confirm reach the same host. The alias makes
   * a better pane label than the derived hostname, but session names cap
   * shorter than SSH aliases do — both allow the same characters, so trimming
   * an over-long alias is enough to keep it a valid name.
   */
  const connectKnownConnection = (connection: KnownConnection) => {
    setStatus(`Connecting to ${connection.alias}…`);
    void connectSsh(connection.hostName ?? connection.alias, connection.alias.slice(0, 48));
  };

  /**
   * Open an SSH session and re-enter a `screen` on the far side.
   *
   * Takes the two names it actually needs rather than a SessionInfo: callers
   * reconnecting from history or from a stored workspace have a description,
   * not a session, and one of them used to fake the object with a cast.
   */
  const attachRemoteScreen = async (name: string, screenName: string, connection: KnownConnection): Promise<SessionInfo | null> => {
    try {
      const currentApi = api();
      if (!currentApi) return null;
      setStatus(`Attaching to ${name} on ${connection.alias}…`);
      const result = await currentApi.buildRemoteScreenAttach?.(connection, screenName);
      const args = result?.args;
      const dashDashIndex = Array.isArray(args) ? args.indexOf('--') : -1;
      const destination = dashDashIndex > 0 ? args[dashDashIndex - 1] : (connection.hostName ?? connection.alias);
      const ssh = await currentApi.createSshSession({ target: destination, name });
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
      setStatus(`Connected to ${name} on ${connection.alias}`);
      return attached;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return null;
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

  /**
   * Open the prompt box, remembering which pane it was asked from.
   *
   * The pane is captured here rather than when the answer arrives: a suggestion
   * built from one pane's output must not land in another, which is what
   * CONTEXT.md's "associated with a session/task ID" is there to prevent.
   */
  const openSuggest = () => {
    if (!isConfigured(settings.ai)) {
      setSettingsOpen(true);
      setStatus('Set an AI endpoint and model in Settings first.');
      return;
    }
    setSuggest(askSuggestion(active?.id ?? focusedSessionId));
  };

  /** Ask the endpoint, then show what came back. */
  const runSuggest = async (prompt: string) => {
    const currentApi = api();
    const current = suggest;
    if (!currentApi?.requestAiCommand || !current) return;

    // Read the pane now, at the moment the request is made: the setting can
    // change and the pane can scroll while an answer is in flight.
    const sessionId = current.sessionId;
    const session = sessionId ? sessions.find((item) => item.id === sessionId) : undefined;
    const usedOutput = settings.ai.includeOutput && Boolean(sessionId);
    const output = usedOutput && sessionId
      ? boundedTail(terminalReadRef.current.get(sessionId)?.() ?? '', settings.ai.outputChars)
      : '';

    setSuggest({ phase: 'thinking', sessionId, prompt, usedOutput: usedOutput && Boolean(output) });
    try {
      const suggestion = await currentApi.requestAiCommand(
        { baseUrl: settings.ai.baseUrl, model: settings.ai.model },
        {
          prompt,
          ...(sessionId ? { sessionId } : {}),
          context: {
            ...(session?.backend ? { shell: backendLabel(session.backend) } : {}),
            ...(session?.cwd ? { cwd: session.cwd } : {}),
            ...(session?.host ? { host: session.host } : {}),
            ...(session?.kind ? { kind: session.kind } : {}),
            ...(output ? { output } : {})
          }
        }
      );

      const withOutput = usedOutput && Boolean(output);
      if (canAutoRun(settings.ai, withOutput, suggestion.command) && sessionId) {
        // Approval is off and nothing but metadata was sent, so the setting is
        // taken at its word.
        currentApi.write(sessionId, `${suggestion.command}\r`);
        setSuggest(null);
        setStatus(`Ran suggestion: ${suggestion.command}`);
        return;
      }
      setSuggest({ phase: 'reviewing', sessionId, prompt, usedOutput: withOutput, suggestion });
    } catch (error) {
      setSuggest({ phase: 'failed', sessionId, prompt, message: ipcMessage(error) });
    }
  };

  /** Send the reviewed command to the pane it was built from. */
  const acceptSuggestion = () => {
    if (suggest?.phase !== 'reviewing') return;
    const { sessionId, suggestion } = suggest;
    setSuggest(null);
    if (!sessionId || !suggestion.command) return;
    api()?.write(sessionId, `${suggestion.command}\r`);
    setStatus(`Sent: ${suggestion.command}`);
    focusTerminal(sessionId);
  };

  const refreshAiModels = async () => {
    const currentApi = api();
    if (!currentApi?.listAiModels) return;
    try {
      setAiModels(await currentApi.listAiModels(settings.ai.baseUrl));
    } catch (error) {
      setAiModels([]);
      setStatus(ipcMessage(error));
    }
  };

  const runAiTest = async () => {
    const currentApi = api();
    if (!currentApi?.testAiEndpoint) return;
    setAiTest({ status: 'testing', message: null });
    const result = await currentApi.testAiEndpoint({ baseUrl: settings.ai.baseUrl, model: settings.ai.model });
    setAiTest({ status: 'idle', ok: result.ok, message: result.message });
  };

  /**
   * The hosts a port could be shared through.
   *
   * Saved connections plus the hosts of live SSH sessions: a tunnel is its own
   * `ssh` process, so it does not need a terminal open to the host first — but
   * if one is open, that is almost certainly the host meant.
   */
  const forwardHosts = useMemo(() => {
    const hosts = new Set<string>();
    for (const session of sessions) {
      if (session.kind === 'ssh' && session.host) hosts.add(session.host);
    }
    for (const connection of knownConnections) hosts.add(connection.hostName ?? connection.alias);
    return [...hosts];
  }, [sessions, knownConnections]);

  const openSharePortDialog = () => {
    setForwardTarget((current) => current || (active?.kind === 'ssh' ? active.host : forwardHosts[0]) || '');
    setForwardAdvanced(false);
    setModal('forward');
  };

  /**
   * Open a tunnel, or say why it cannot be opened.
   *
   * The row appears before the client has connected and follows itself through
   * `connecting` to `open` on the event stream, so a slow host looks like a slow
   * host rather than a dead button.
   */
  const shareForward = async (request: Omit<PortForwardInfo, 'status'>) => {
    const currentApi = api();
    if (!currentApi?.openForward) return;
    const conflict = forwardConflict(request, forwards);
    if (conflict) {
      setStatus(conflict);
      return;
    }
    setSidebarView('ports');
    setForwards((current) => applyForwardStatus(current, { ...request, status: 'connecting' }));
    try {
      const opened = await currentApi.openForward(request);
      setForwards((current) => applyForwardStatus(current, opened));
      setStatus(`Sharing ${forwardLabel(opened)}`);
    } catch (error) {
      const message = ipcMessage(error);
      // Kept in the list as an error rather than removed: the user asked for it,
      // and a row that says why beats a row that silently never appeared.
      setForwards((current) => applyForwardStatus(current, { ...request, status: 'error', message }));
      setStatus(message);
    }
  };

  const createForward = async (event: React.FormEvent) => {
    event.preventDefault();
    const listenPort = Number(forwardListenPort);
    // The far side defaults to the same number, which is what is wanted almost
    // every time and saves typing it twice.
    const destinationPort = Number(forwardDestinationPort || forwardListenPort);
    // Checked here, not left to the client: a number the range rejects is a
    // typo, and the dialog staying open with the message beats closing it and
    // leaving a row that only says what was already typed. The service checks
    // again regardless — it cannot trust this side.
    const unusable = [listenPort, destinationPort].some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65535
    );
    if (unusable) {
      setStatus('A port must be a whole number between 1 and 65535.');
      return;
    }
    setModal(null);
    await shareForward({
      id: `forward:${crypto.randomUUID()}`,
      target: forwardTarget.trim(),
      direction: forwardDirection,
      bind: forwardBind,
      listenPort,
      destinationPort,
      ...(forwardDestinationHost.trim() ? { destinationHost: forwardDestinationHost.trim() } : {})
    });
  };

  const closeForward = async (forward: PortForwardInfo) => {
    const currentApi = api();
    // Dropped from the list whatever the main process says: the user asked for it
    // to stop, and a row that lingers after the cross looks broken.
    setForwards((current) => current.filter((item) => item.id !== forward.id));
    setStatus(`Stopped sharing ${listenerLabel(forward)}`);
    try {
      await currentApi?.closeForward?.(forward.id);
    } catch {
      /* already gone */
    }
  };

  const openNewWorkspace = () => {
    setWorkspaceName(nextWorkspaceName(workspaces));
    setModal('workspace');
  };

  /**
   * Make a workspace the active one.
   *
   * Only the id moves. Layout, selection, focus, and maximize come along
   * because they live on the workspace being switched to — the arrangement it
   * had when it was last on screen is the arrangement it comes back with.
   */
  const switchWorkspace = (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) return;
    const target = workspaces.find((workspace) => workspace.id === workspaceId);
    if (!target) return;
    setRenamingWorkspace(false);
    setActiveWorkspaceId(workspaceId);
    setStatus(`Workspace “${target.name}”`);
  };

  /**
   * Close a workspace, leaving its shells alone.
   *
   * Only the grouping goes away: a `screen` session it held keeps running and
   * goes back to being unclaimed inventory under Screens, which is the same
   * promise the app makes when the whole window closes.
   */
  const closeWorkspaceTab = (workspaceId: string) => {
    const target = workspaces.find((workspace) => workspace.id === workspaceId);
    const result = closeWorkspace(workspaces, workspaceId, activeWorkspaceId);
    if (result.workspaces === workspaces) return;
    setRenamingWorkspace(false);
    setWorkspaces(result.workspaces);
    setActiveWorkspaceId(result.activeWorkspaceId);
    // Nothing needs re-pointing: the selection and focus that named those
    // sessions went with the view of the workspace that held them.
    const count = result.releasedSessionIds.length;
    setStatus(
      count
        ? `Closed workspace “${target?.name}” · ${count} session${count === 1 ? '' : 's'} still running`
        : `Closed workspace “${target?.name}”`
    );
  };

  const startRenameWorkspace = () => {
    if (!activeWorkspace) return;
    setRenameDraft(activeWorkspace.name);
    setRenamingWorkspace(true);
  };

  /**
   * Commit an inline rename, or abandon it.
   *
   * Called on blur as well as Enter, so an invalid or empty draft has to be
   * refused rather than clamped — moving focus away must not be able to
   * overwrite a good name with a half-typed one. renameWorkspace returns the
   * list unchanged in that case.
   */
  const commitRenameWorkspace = () => {
    setRenamingWorkspace(false);
    if (!activeWorkspace) return;
    const value = renameDraft.trim();
    if (!isWorkspaceName(value) || value === activeWorkspace.name) return;
    setWorkspaces((current) => renameWorkspace(current, activeWorkspace.id, value));
    setStatus(`Workspace renamed to “${value}”`);
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

  /**
   * The Ports view: tunnels grouped by the host they run through.
   *
   * Grouped by host rather than listed flat because a port number means nothing
   * without knowing which machine it reaches, and because the same number can be
   * shared to two hosts at once.
   */
  const renderPortsView = () => {
    if (!forwards.length) {
      return (
        <div className="session-list">
          <div className="session-empty">
            <b>No shared ports</b>
            <small>Share a port to reach a service on a remote host from this machine, or the other way round.</small>
            <button type="button" onClick={openSharePortDialog}>Share a port</button>
          </div>
        </div>
      );
    }
    return (
      <div className="session-list">
        {groupForwards(forwards).map((group) => (
          <React.Fragment key={group.host}>
            <div className="session-group-label">{group.host}</div>
            {group.forwards.map((forward) => (
              <div className={`session-row forward-row ${forward.status === 'idle' ? 'session-ghosted' : ''}`} key={forward.id}>
                <span className={`status-dot ${forwardDotState(forward)}`} />
                <button
                  type="button"
                  className="forward-open"
                  // An idle row is a remembered one: clicking it is what asks for
                  // the tunnel, the same gesture as a restored SSH pane.
                  onClick={() => (forward.status === 'idle' || forward.status === 'error'
                    ? void shareForward(forward)
                    : undefined)}
                  title={forward.status === 'idle' || forward.status === 'error' ? `Reconnect ${listenerLabel(forward)}` : forwardLabel(forward)}
                >
                  <span className="session-copy">
                    <b>{listenerLabel(forward)}</b>
                    <small>
                      {forward.direction === 'local' ? '←' : '→'} {forward.destinationHost || 'localhost'}:{forward.destinationPort}
                      {forward.status === 'connecting' ? ' · connecting…' : ''}
                      {forward.status === 'idle' ? ' · not connected' : ''}
                      {forward.status === 'error' ? ` · ${forward.message ?? 'failed'}` : ''}
                    </small>
                  </span>
                </button>
                {/* Said plainly rather than left to be worked out: a wide bind
                    re-exports someone else's service onto this network. */}
                {isWidelyBound(forward) && <span className="forward-badge" title="Reachable from your network, not just this machine">LAN</span>}
                <button
                  type="button"
                  className="forward-close"
                  onClick={() => void closeForward(forward)}
                  title={`Stop sharing ${listenerLabel(forward)}`}
                  aria-label={`Stop sharing ${listenerLabel(forward)}`}
                >
                  ×
                </button>
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
    );
  };

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

  // Which dividers this layout has. A maximized pane covers the grid, so its
  // dividers would move panes nobody can see.
  const splitsColumns = !maximizedPaneId && (layout === 'split-v' || layout === 'grid');
  const splitsRows = !maximizedPaneId && (layout === 'split-h' || layout === 'grid');
  const columnRatio = settings.sessions.splitColumnRatio;
  const rowRatio = settings.sessions.splitRowRatio;
  const paneGridRef = useRef<HTMLDivElement>(null);
  // Dragged sizes go through updateSection, which clamps them, so the templates
  // below can only ever describe a split with room for a terminal on both sides.
  const paneGridStyle: React.CSSProperties | undefined = maximizedPaneId
    ? undefined
    : {
        ...(splitsColumns ? { gridTemplateColumns: `${columnRatio}fr ${1 - columnRatio}fr` } : {}),
        ...(splitsRows ? { gridTemplateRows: `${rowRatio}fr ${1 - rowRatio}fr` } : {})
      };

  /** Turn a pointer position into the share of the grid taken by the first pane. */
  const dragSplit = (axis: 'column' | 'row', position: { clientX: number; clientY: number }) => {
    const box = paneGridRef.current?.getBoundingClientRect();
    if (!box) return;
    const ratio = axis === 'column'
      ? (position.clientX - box.left) / box.width
      : (position.clientY - box.top) / box.height;
    if (!Number.isFinite(ratio)) return;
    changeSettingLive('sessions', axis === 'column' ? { splitColumnRatio: ratio } : { splitRowRatio: ratio });
  };

  const nudgeSplit = (axis: 'column' | 'row', direction: -1 | 1) => {
    const current = axis === 'column' ? columnRatio : rowRatio;
    const next = current + direction * 0.02;
    changeSetting('sessions', axis === 'column' ? { splitColumnRatio: next } : { splitRowRatio: next });
  };

  const resetSplit = (axis: 'column' | 'row') => {
    changeSetting('sessions', axis === 'column'
      ? { splitColumnRatio: DEFAULT_SETTINGS.sessions.splitColumnRatio }
      : { splitRowRatio: DEFAULT_SETTINGS.sessions.splitRowRatio });
  };

  // Everything the layout buttons weigh up, gathered once so the tooltip and
  // the click cannot read a different grid.
  const paneView: PaneView = {
    layout,
    maximized: Boolean(maximizedPaneId),
    columnRatio,
    rowRatio,
    sessionCount: workspaceSessions.length,
    lastSplit: view.lastSplit
  };

  const sidebarRef = useRef<HTMLElement>(null);
  const dragSidebar = (position: { clientX: number }) => {
    const box = sidebarRef.current?.getBoundingClientRect();
    if (!box) return;
    changeSettingLive('sessions', { sidebarWidth: Math.round(position.clientX - box.left) });
  };

  const toggleMaximize = (sessionId: string) => {
    patchView((current) => ({
      focusedSessionId: sessionId,
      maximizedSessionId: current.maximizedSessionId === sessionId ? null : sessionId
    }));
  };

  /** Carry out what the layout rules decided a click should do. */
  const applyPaneAction = (action: PaneAction) => {
    if (action.kind === 'restore') {
      setMaximizedSessionId(null);
      return;
    }
    if (action.kind === 'show') {
      // A maximized pane would otherwise mask the layout it changed to.
      setMaximizedSessionId(null);
      setLayout(action.layout);
      return;
    }
    if (action.kind === 'reset-splits') {
      changeSetting('sessions', action.ratios);
      return;
    }
    const focused = focusedSessionId ?? active?.id ?? workspaceSessions[0]?.id;
    if (focused) setMaximizedSessionId(focused);
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
  // engine and the request for the server engine, so the pane mic and the
  // settings test always run whatever is configured right now.
  const speechClient = () => {
    speechRef.current ??= new SpeechClient({
      // Worker's onmessage is typed around MessageEvent; the client only reads
      // `.data`, so this narrowing cast is safe and stays at the boundary.
      createWorker: () =>
        new Worker(new URL('./voice-worker.ts', import.meta.url), { type: 'module' }) as unknown as SpeechWorker,
      // Read per request rather than held here: a key saved or cleared in
      // settings applies to the next utterance without rebuilding the client.
      resolveApiKey: async () => sessionSpeechKeyRef.current ?? (await window.zerog?.readSpeechApiKey()) ?? null
    });
    return speechRef.current;
  };

  /**
   * Save a speech server key, or keep it for the session when this system
   * cannot encrypt it.
   *
   * A refusal from the main process is not a failure to report and forget: the
   * user has a key in hand and a server that wants it, so it is held in memory
   * and the panel says that is what happened.
   */
  const saveSpeechKey = async (key: string) => {
    const currentApi = api();
    if (!currentApi?.saveSpeechApiKey) return;
    setSpeechKey((previous) => ({ ...previous, status: 'saving', error: null, notice: null }));
    try {
      const status = await currentApi.saveSpeechApiKey(key);
      sessionSpeechKeyRef.current = null;
      setSpeechKey({
        status: 'idle',
        stored: status.stored,
        encryptionAvailable: status.encryptionAvailable,
        sessionOnly: false,
        notice: status.stored ? 'Key saved, encrypted by this system.' : 'Key cleared.'
      });
    } catch (error) {
      sessionSpeechKeyRef.current = key;
      setSpeechKey((previous) => ({
        ...previous,
        status: 'idle',
        stored: false,
        encryptionAvailable: false,
        sessionOnly: true,
        notice: 'Kept for this session only — it could not be stored safely, so it is gone when ZeroG closes.',
        error: null
      }));
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const clearSpeechKey = async () => {
    const currentApi = api();
    sessionSpeechKeyRef.current = null;
    if (!currentApi?.clearSpeechApiKey) {
      setSpeechKey((previous) => ({ ...previous, stored: false, sessionOnly: false, notice: 'Key cleared.', error: null }));
      return;
    }
    try {
      const status = await currentApi.clearSpeechApiKey();
      setSpeechKey((previous) => ({ ...previous, status: 'idle', stored: status.stored, sessionOnly: false, notice: 'Key cleared.', error: null }));
    } catch (error) {
      setSpeechKey((previous) => ({ ...previous, status: 'idle', sessionOnly: false, error: error instanceof Error ? error.message : String(error) }));
    }
  };

  /**
   * Save or clear the AI endpoint key.
   *
   * Simpler than the speech pair: there is no in-memory fallback for a machine
   * without a keyring. A suggestion is not worth holding a key in renderer
   * memory for, and the panel already says when a system cannot encrypt one.
   */
  const saveAiKey = async (key: string) => {
    const currentApi = api();
    if (!currentApi?.saveAiApiKey) return;
    setAiKey((previous) => ({ ...previous, status: 'saving', error: null, notice: null }));
    try {
      const status = await currentApi.saveAiApiKey(key);
      setAiKey({
        status: 'idle',
        stored: status.stored,
        encryptionAvailable: status.encryptionAvailable,
        sessionOnly: false,
        notice: status.stored ? 'Key saved, encrypted by this system.' : 'Key cleared.'
      });
    } catch (error) {
      setAiKey((previous) => ({ ...previous, status: 'idle', error: ipcMessage(error) }));
    }
  };

  const clearAiKey = async () => {
    const currentApi = api();
    if (!currentApi?.clearAiApiKey) return;
    try {
      const status = await currentApi.clearAiApiKey();
      setAiKey((previous) => ({ ...previous, status: 'idle', stored: status.stored, notice: 'Key cleared.', error: null }));
    } catch (error) {
      setAiKey((previous) => ({ ...previous, status: 'idle', error: ipcMessage(error) }));
    }
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

  /**
   * Send the proceed phrase to a pane, Enter included.
   *
   * The one place in the app that presses Enter for the user. It is not a
   * command being run on their behalf — it is a reply to an agent already
   * waiting in that pane, which is the whole point of the button — but it does
   * reach a shell prompt as a command if the pane is sitting at one, so the
   * status line says exactly what was sent.
   */
  const sendProceed = (session: SessionInfo) => {
    const currentApi = api();
    if (!currentApi) return;
    const phrase = resolveProceedPhrase(settings.ai);
    currentApi.write(session.id, `${phrase}\r`);
    setStatus(`Sent "${phrase}" to ${session.name}`);
    focusTerminal(session.id);
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
            ? 'Transcribed by the server.'
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
    setWorkspaces((current) => {
      // releaseSession has already cleared any view field that named the pane
      // being closed, so the `??` here only fires for those — selection and
      // focus land on a surviving terminal instead of on nothing.
      const released = releaseSession(current, session.id);
      return updateView(released, activeWorkspaceId, (current) => ({
        activeSessionId: current.activeSessionId ?? remaining[0]?.id,
        focusedSessionId: current.focusedSessionId ?? remaining[0]?.id,
        layout: layoutForSessionCount(remaining.length)
      }));
    });

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
          {workspaces.map((workspace, index) => {
            // The last workspace cannot be closed: there would be nowhere for the
            // panes, the sidebar header, or this strip to point.
            const closable = workspaces.length > 1;
            const dot = workspaceDotState(workspace, sessions);
            return (
              <span className={`workspace-tab-slot ${closable ? 'closable' : ''}`} key={workspace.id}>
                <button
                  type="button"
                  className={`workspace-tab ${workspace.id === activeWorkspace?.id ? 'active' : ''}`}
                  title={`Switch to ${workspace.name}${index < 9 ? ` (Ctrl+Shift+${index + 1})` : ''}`}
                  onClick={() => switchWorkspace(workspace.id)}
                >
                  <span className={`status-dot ${dot === 'empty' ? '' : dot}`} />
                  {workspace.name}
                  <span className="tab-meta">{workspacePaneCount(workspace)}</span>
                </button>
                {closable && (
                  <button
                    type="button"
                    className="workspace-tab-close"
                    title={`Close ${workspace.name} · its terminals keep running`}
                    aria-label={`Close workspace ${workspace.name}`}
                    onClick={() => closeWorkspaceTab(workspace.id)}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
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
            <span>Workspace</span>
          </button>
          <button
            type="button"
            className="bar-button"
            onClick={openSuggest}
            title={isConfigured(settings.ai) ? 'Ask for a command (Ctrl+Shift+A)' : 'Set an AI endpoint in Settings first'}
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
          <button
            type="button"
            className={`rail-button ${!drawerCollapsed && sidebarView === 'sessions' ? 'active' : ''}`}
            title="Sessions"
            onClick={() => { setSidebarView('sessions'); setDrawerCollapsed(false); }}
          >
            <Icon name="sessions" />
          </button>
          <button type="button" className="rail-button" onClick={() => setOverview(true)} title="Overview">
            <Icon name="grid" />
          </button>
          <button
            type="button"
            className={`rail-button ${!drawerCollapsed && sidebarView === 'ports' ? 'active' : ''}`}
            title="Shared ports"
            aria-label="Shared ports"
            onClick={() => { setSidebarView('ports'); setDrawerCollapsed(false); }}
          >
            <Icon name="ports" />
          </button>
          <span className="rail-spacer" />
          <button
            type="button"
            className="rail-button"
            onClick={openSharePortDialog}
            title="Share a port over SSH"
            aria-label="Share a port"
          >
            <Icon name="port-plus" />
          </button>
          <button
            type="button"
            className="rail-button"
            onClick={openNewLocalTerminal}
            title="New local terminal (Ctrl+Shift+T)"
            aria-label="New local terminal"
          >
            <Icon name="terminal" />
          </button>
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
          <aside className="session-drawer" ref={sidebarRef} style={{ width: settings.sessions.sidebarWidth }}>
            <div className="drawer-head">
              <div className="drawer-head-name">
                <span className="eyebrow">{sidebarView === 'ports' ? 'SHARED PORTS' : 'WORKSPACE'}</span>
                {sidebarView === 'ports' ? (
                  <h1>Ports</h1>
                ) : renamingWorkspace && activeWorkspace ? (
                  <input
                    className="workspace-rename"
                    autoFocus
                    aria-label="Workspace name"
                    value={renameDraft}
                    pattern={WORKSPACE_NAME_PATTERN}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onBlur={commitRenameWorkspace}
                    onKeyDown={(event) => {
                      // Kept off the window handler: Escape there hunts for an
                      // overlay to close, and Enter has no business leaving a
                      // field the user is still typing in.
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.stopPropagation();
                        commitRenameWorkspace();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        event.stopPropagation();
                        setRenamingWorkspace(false);
                      }
                    }}
                  />
                ) : (
                  <h1
                    onDoubleClick={startRenameWorkspace}
                    title={activeWorkspace ? 'Double-click to rename this workspace' : undefined}
                  >
                    {activeWorkspace?.name ?? 'Sessions'}
                  </h1>
                )}
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
                  onClick={openNewWorkspace}
                  title="New workspace (Ctrl+Shift+N)"
                  aria-label="New workspace"
                >
                  <Icon name="plus" />
                </button>
              </div>
            </div>

            {sidebarView === 'ports' ? renderPortsView() : (
              <>
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
                  workspaceSessions.length || pendingPanes.length ? (
                    <>
                      {workspaceSessions.map((session) => (
                        <SessionRow key={session.id} session={session} active={active?.id === session.id} onClick={() => void attach(session)} />
                      ))}
                      {/* Panes this workspace remembers but has not reconnected.
                          Ghosted like a discovered screen, because that is what
                          they are to the user: something known to belong here that
                          is not running in front of them yet. */}
                      {pendingPanes.map((member) => (
                        <PendingPaneRow key={member.sessionId} member={member} onClick={() => void restorePendingPane(member)} />
                      ))}
                    </>
                  ) : <div className="session-empty"><b>No terminals yet</b><small>Add a local terminal or SSH connection to this workspace.</small></div>
                ) : sidebarTab === 'screens' ? (
                    renderScreensTab()
                  ) : sidebarTab === 'connections' ? (
                  knownConnections.length ? knownConnections.map((connection) => (
                    <ConnectionRow
                      key={connection.alias}
                      connection={connection}
                      onConfigure={() => openSessionDialog('ssh', { sshTarget: connection.hostName ?? connection.alias })}
                      onConnect={() => connectKnownConnection(connection)}
                    />
                  )) : <div className="session-empty"><b>No saved connections</b><small>Add Host entries to ~/.ssh/config to populate connections.</small></div>
                ) : (
                  sessions.filter((session) => session.kind === 'ssh' && session.scope === 'remote' && session.source === 'discovered').length ? sessions.filter((session) => session.kind === 'ssh' && session.scope === 'remote' && session.source === 'discovered').map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      ghosted
                      onClick={async () => {
                        setStatus(`Attaching remote screen ${session.name}…`);
                        const currentApi = api();
                        if (!currentApi) return;
                        try {
                          const result = await currentApi.buildRemoteScreenAttach?.({ alias: session.host, hostName: session.host }, session.screenName ?? session.name);
                          const destination = result?.args?.find((arg) => arg.includes('@') || !arg.startsWith('-')) ?? session.host;
                          const ssh = await currentApi.createSshSession({ target: destination, name: session.name });
                          setSessions((current) => current.map((item) => item.id === session.id ? ssh : item));
                          // Claim the session that now exists, not the discovered
                          // row it replaced: the two have different ids, and the
                          // workspace would otherwise hold one that is gone.
                          claimSession(ssh);
                          await attach(ssh);
                        } catch (error) {
                          setStatus(error instanceof Error ? error.message : String(error));
                        }
                      }}
                    />
                  )) : <div className="session-empty"><b>No remote screens</b><small>Remote screen sessions will appear here after discovery.</small></div>
                )}
              </div>
              </>
            )}

            <div className="drawer-bottom">
              <button type="button" className="drawer-action" onClick={openSharePortDialog}>
                <Icon name="port-plus" /> Share port
              </button>
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

        {!drawerCollapsed && (
          <ResizeHandle
            orientation="vertical"
            className="sidebar-resizer"
            label="Sidebar width"
            valuePercent={(settings.sessions.sidebarWidth / SETTING_LIMITS.sidebarWidth.max) * 100}
            onDrag={dragSidebar}
            onCommit={() => changeSetting('sessions', { sidebarWidth: settings.sessions.sidebarWidth })}
            onNudge={(direction) => changeSetting('sessions', { sidebarWidth: settings.sessions.sidebarWidth + direction * 16 })}
            onReset={() => changeSetting('sessions', { sidebarWidth: DEFAULT_SETTINGS.sessions.sidebarWidth })}
          />
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
            {/* Both control groups live in one box: the head is spaced apart,
                so a third child of its own would be pushed into the middle of
                the bar instead of sitting beside the layout buttons. */}
            <div className="head-controls">
              <div className="layout-controls">
                <span className="control-label">SFTP</span>
                <button
                  type="button"
                  className={transferOpen ? 'layout-button active' : 'layout-button'}
                  onClick={() => setTransferOpen((value) => !value)}
                  // A preload without the transfer API means a stale build; the
                  // button says nothing rather than failing on the first click.
                  disabled={!transfer.available || !api()?.sftpOpen}
                  title={transfer.reason}
                  aria-label="Transfer files over SFTP"
                >
                  <Icon name="transfer" />
                </button>
              </div>
              <div className="layout-controls">
                <span className="control-label">LAYOUT</span>
                <button
                  type="button"
                  className={layout === 'stack' || maximizedPaneId ? 'layout-button active' : 'layout-button'}
                  onClick={() => applyPaneAction(singlePaneAction(paneView))}
                  title={singlePaneTitle(paneView)}
                >
                  <Icon name="stack" />
                </button>
                {SPLIT_BUTTONS.map(({ layout: target, icon }) => (
                  <button
                    key={target}
                    type="button"
                    className={layout === target && !maximizedPaneId ? 'layout-button active' : 'layout-button'}
                    onClick={() => applyPaneAction(splitButtonAction(target, paneView))}
                    title={splitButtonTitle(target, paneView)}
                  >
                    <Icon name={icon} />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className={`${paneClass} ${maximizedPaneId ? 'maximized-pane-grid' : ''}`} ref={paneGridRef} style={paneGridStyle}>
            {/* Absolutely positioned, so they overlay the 1px grid gap instead of
                becoming grid items — which would need a different track layout
                for each of the three split layouts. Offset by half the gap so the
                grab strip is centred on the line the user sees. */}
            {splitsColumns && (
              <ResizeHandle
                orientation="vertical"
                className="pane-resizer pane-resizer-column"
                label="Pane column split"
                valuePercent={columnRatio * 100}
                style={{ left: `calc((100% - 1px) * ${columnRatio} + 0.5px)` }}
                onDrag={(position) => dragSplit('column', position)}
                onCommit={() => changeSetting('sessions', { splitColumnRatio: columnRatio })}
                onNudge={(direction) => nudgeSplit('column', direction)}
                onReset={() => resetSplit('column')}
              />
            )}
            {splitsRows && (
              <ResizeHandle
                orientation="horizontal"
                className="pane-resizer pane-resizer-row"
                label="Pane row split"
                valuePercent={rowRatio * 100}
                style={{ top: `calc((100% - 1px) * ${rowRatio} + 0.5px)` }}
                onDrag={(position) => dragSplit('row', position)}
                onCommit={() => changeSetting('sessions', { splitRowRatio: rowRatio })}
                onNudge={(direction) => nudgeSplit('row', direction)}
                onReset={() => resetSplit('row')}
              />
            )}
            {allPanes.map(({ session: paneSession, index, dormant }) => {
              const paneVoice = voice.sessionId === paneSession.id && voice.status !== 'idle' ? voice.status : null;
              return (
                <article
                  className={`pane terminal-pane ${dormant ? 'dormant-pane' : ''} ${!dormant && focusedSessionId === paneSession.id ? 'focused' : ''} ${!dormant && maximizedPaneId === paneSession.id ? 'maximized-pane' : ''} ${dormant || isPaneVisible(paneSession, index) ? '' : 'overflow-pane'}`}
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
                        className="pane-proceed"
                        onClick={() => sendProceed(paneSession)}
                        title={`Send "${proceedPhrase}" and press Enter`}
                        aria-label={`Send "${proceedPhrase}" to ${paneSession.name}`}
                      >
                        <Icon name="check" />
                      </button>
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
                    focused={!dormant && focusedSessionId === paneSession.id}
                    dormant={dormant}
                    onStatus={setStatus}
                    appearance={settings.appearance}
                    terminalSettings={settings.terminal}
                    registerFocus={registerTerminalFocus}
                    registerRead={registerTerminalRead}
                  />
                </article>
              );
            })}
            {/* Empty slots of the active workspace. After the panes, so grid
                auto-placement fills them from the end. */}
            {Array.from({ length: Math.max(0, renderedPaneCount - paneSessions.length) }, (_, index) => (
              <PanePlaceholder
                key={`placeholder-${index}`}
                index={paneSessions.length + index + 1}
                onCreate={openNewLocalTerminal}
              />
            ))}
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
              // Same planner the workspaces use, so a shell reconnected from
              // here and one reconnected by a restored workspace end up in the
              // same place. The tab switch is the one thing that is only
              // meaningful from history: it says where to look for the result.
              const action = planSessionRestore(entry.session, sessions, knownConnections);
              setSidebarTab(entry.session.screenName || entry.session.backend === 'screen' ? 'screens' : 'terminals');
              const session = await runRestoreAction(action);
              if (session) setStatus(`Reconnected ${session.name}`);
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
            onSubmit={modal === 'workspace' ? createWorkspace : modal === 'forward' ? createForward : modal === 'local' ? createLocal : createSsh}
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
                    pattern={WORKSPACE_NAME_PATTERN}
                    required
                  />
                </label>
              </>
            )}

            {modal === 'forward' && (
              <>
                <p>Reach a port on a remote host from this machine, over SSH. The tunnel is its own connection, so the host does not need a terminal open.</p>
                <label>
                  SSH host
                  <input
                    autoFocus
                    list="forward-hosts"
                    value={forwardTarget}
                    onChange={(event) => setForwardTarget(event.target.value)}
                    placeholder="user@server"
                    required
                  />
                  <datalist id="forward-hosts">
                    {forwardHosts.map((host) => <option key={host} value={host} />)}
                  </datalist>
                </label>
                <label>
                  Port
                  <input
                    value={forwardListenPort}
                    onChange={(event) => setForwardListenPort(event.target.value)}
                    inputMode="numeric"
                    pattern="[0-9]{1,5}"
                    placeholder="3000"
                    required
                  />
                </label>
                {/* The uncommon choices, folded away: almost every forward is a
                    remote port reached here on the same number, bound to
                    loopback. */}
                <button type="button" className="dialog-disclosure" onClick={() => setForwardAdvanced((value) => !value)} aria-expanded={forwardAdvanced}>
                  {forwardAdvanced ? 'Fewer options' : 'More options'}
                </button>
                {forwardAdvanced && (
                  <>
                    <label>
                      Direction
                      <select value={forwardDirection} onChange={(event) => setForwardDirection(event.target.value as ForwardDirection)}>
                        <option value="local">Remote port, reachable here</option>
                        <option value="remote">Port here, reachable on the remote</option>
                      </select>
                    </label>
                    <label>
                      Forward to <span className="muted-text">optional</span>
                      <input
                        value={forwardDestinationHost}
                        onChange={(event) => setForwardDestinationHost(event.target.value)}
                        placeholder="localhost"
                      />
                    </label>
                    <label>
                      Port on that side <span className="muted-text">defaults to the same</span>
                      <input
                        value={forwardDestinationPort}
                        onChange={(event) => setForwardDestinationPort(event.target.value)}
                        inputMode="numeric"
                        pattern="[0-9]{1,5}"
                        placeholder={forwardListenPort || '3000'}
                      />
                    </label>
                    <label className="dialog-check">
                      <input
                        type="checkbox"
                        checked={forwardBind === 'all'}
                        onChange={(event) => setForwardBind(event.target.checked ? 'all' : 'loopback')}
                      />
                      Share on my network, not just this machine
                    </label>
                    {forwardBind === 'all' && (
                      <p className="dialog-warning">
                        Anything on the network this machine is attached to will be able to reach
                        {forwardDirection === 'local' ? ' the remote service' : ' the service running here'}.
                      </p>
                    )}
                  </>
                )}
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

      {transferOpen && active && transferTarget && api() && (
        // Keyed on the session: pointing the panel at a different host is a new
        // connection and a new pair of directories, not an update of this one.
        <SftpPanel
          key={active.id}
          session={active}
          target={transferTarget}
          api={api() as TerminalApi}
          onClose={() => setTransferOpen(false)}
          backdrop={dismissTransfer}
        />
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
          speechKey={speechKey}
          onSpeechKeySave={(key) => void saveSpeechKey(key)}
          onSpeechKeyClear={() => void clearSpeechKey()}
          aiKey={aiKey}
          onAiKeySave={(key) => void saveAiKey(key)}
          onAiKeyClear={() => void clearAiKey()}
          aiModels={aiModels}
          onAiModelsRefresh={() => void refreshAiModels()}
          aiTest={aiTest}
          onAiTest={() => void runAiTest()}
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

      {/* What the SSH client wants before a tunnel can open. ZeroG never answers
          a host-key question on the user's behalf, and the fingerprint is shown
          with the question — the same rule the transfer panel follows, because
          it is the same client asking. Nothing typed here is stored. */}
      {forwardPrompt && (
        <div className="modal-layer" role="presentation">
          <form
            className="modal-card approval-card"
            onSubmit={(event) => {
              event.preventDefault();
              const answer = new FormData(event.currentTarget).get('answer');
              const currentApi = api();
              setForwardPrompt(null);
              void currentApi?.answerForwardPrompt?.(forwardPrompt.forwardId, String(answer ?? '')).catch((error: unknown) => {
                setStatus(ipcMessage(error));
              });
            }}
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow">SHARED PORT</span>
                <h2>{forwardPrompt.kind === 'confirm' ? 'Accept this host key?' : 'The host is asking'}</h2>
              </div>
            </div>
            <code>{forwardPrompt.text}</code>
            <label>
              {forwardPrompt.kind === 'confirm' ? 'Type yes, no, or the fingerprint' : 'Answer'}
              <input
                autoFocus
                name="answer"
                type={forwardPrompt.kind === 'confirm' ? 'text' : 'password'}
                autoComplete="off"
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  // Cancelling has to end the attempt, not leave a client sitting
                  // at a prompt nobody is going to answer.
                  const id = forwardPrompt.forwardId;
                  setForwardPrompt(null);
                  void api()?.closeForward?.(id).catch(() => undefined);
                  setForwards((current) => current.map((item) => (item.id === id ? { ...item, status: 'idle' as const } : item)));
                }}
              >
                Cancel
              </button>
              <button className="primary-button" type="submit">Send</button>
            </div>
          </form>
        </div>
      )}

      {/* One dialog through the whole exchange: ask, wait, then review. The
          command is shown before it can run whenever terminal output was part
          of the prompt — see canAutoRun in ai-suggest.ts — because the answer is
          then downstream of text a remote host chose. */}
      {suggest && (
        <div className="modal-layer" role="presentation" {...dismissSuggest}>
          <div className="modal-card approval-card">
            <div className="modal-head">
              <div>
                <span className={suggest.phase === 'reviewing' ? 'eyebrow warning-text' : 'eyebrow'}>
                  {suggest.phase === 'reviewing' ? 'APPROVAL REQUIRED' : 'AI SUGGESTION'}
                </span>
                <h2>
                  {suggest.phase === 'asking'
                    ? 'What would you like to do?'
                    : suggest.phase === 'thinking'
                      ? 'Asking the model…'
                      : suggest.phase === 'failed'
                        ? 'No suggestion'
                        : 'Run this command?'}
                </h2>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={() => {
                  void api()?.cancelAiRequest?.();
                  setSuggest(null);
                }}
              >
                Esc
              </button>
            </div>

            {suggest.phase === 'asking' && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const prompt = String(new FormData(event.currentTarget).get('prompt') ?? '').trim();
                  if (prompt) void runSuggest(prompt);
                }}
              >
                <p>
                  {settings.ai.model} at {settings.ai.baseUrl}.{' '}
                  {settings.ai.includeOutput
                    ? 'The last of this pane\u2019s output is sent with your request.'
                    : 'Only the shell, directory and host are sent.'}
                </p>
                <label>
                  Request
                  <input autoFocus name="prompt" placeholder="fix that error" autoComplete="off" />
                </label>
                <div className="modal-actions">
                  <button type="button" onClick={() => setSuggest(null)}>Cancel</button>
                  <button className="primary-button" type="submit">Ask</button>
                </div>
              </form>
            )}

            {suggest.phase === 'thinking' && (
              <>
                <p>{suggest.prompt}</p>
                <p className="muted-text">
                  {suggest.usedOutput ? 'Sent with recent output from this pane.' : 'Sent without terminal output.'}
                </p>
                <div className="modal-actions">
                  <button
                    type="button"
                    onClick={() => {
                      void api()?.cancelAiRequest?.();
                      setSuggest(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {suggest.phase === 'reviewing' && (
              <>
                <p>{suggest.suggestion.explanation}</p>
                {suggest.suggestion.command ? <code>{suggest.suggestion.command}</code> : null}
                {suggest.usedOutput ? (
                  <p className="dialog-warning">
                    This was suggested from output in the pane, which can come from a remote host. Read the
                    command before running it.
                  </p>
                ) : null}
                <div className="modal-actions">
                  <button type="button" onClick={() => setSuggest(null)}>Cancel</button>
                  {/* Nothing to run when the reply did not parse or named several
                      commands, which is what an empty command means. */}
                  {suggest.suggestion.command ? (
                    <button type="button" className="primary-button" onClick={acceptSuggestion}>Run</button>
                  ) : (
                    <button type="button" onClick={() => setSuggest(askSuggestion(suggest.sessionId))}>Ask again</button>
                  )}
                </div>
              </>
            )}

            {suggest.phase === 'failed' && (
              <>
                <p>{suggest.message}</p>
                <div className="modal-actions">
                  <button type="button" onClick={() => setSuggest(null)}>Close</button>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => setSuggest(askSuggestion(suggest.sessionId))}
                  >
                    Try again
                  </button>
                </div>
              </>
            )}
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

createRoot(document.getElementById('root')!).render(<App />);
