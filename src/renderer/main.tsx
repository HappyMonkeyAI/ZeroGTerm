import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import type { HistoryEntry, KnownConnection, SessionInfo, ShellBackend } from '../shared/types';
type LocalBackend = 'bash' | 'zsh' | 'powershell' | 'wsl';
import { MAX_UTTERANCE_SECONDS, VoiceRecorder, isMostlySilence } from './voice';

type VoiceStatus = 'idle' | 'listening' | 'transcribing';

type Layout = 'stack' | 'split-v' | 'split-h' | 'grid';
type ModalKind = 'workspace' | 'local' | 'ssh' | null;
type Theme = 'dark' | 'light';
type SidebarTab = 'terminals' | 'screens' | 'connections';

type Workspace = {
  id: string;
  name: string;
  sessionIds: string[];
};

const api = () => window.zerog;

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
    : session.backend === 'powershell'
      ? `PowerShell · ${session.cwd}`
      : session.backend === 'wsl'
        ? `WSL${session.wslDistribution ? ` · ${session.wslDistribution}` : ''} · ${session.cwd}`
        : session.backend === 'zsh'
          ? `zsh · ${session.cwd}`
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
  if (session.backend === 'powershell') return 'PowerShell';
  if (session.backend === 'zsh') return 'zsh';
  if (session.backend === 'wsl') return session.wslDistribution ? `WSL · ${session.wslDistribution}` : 'WSL';
  return 'bash';
}

function TerminalView({ sessionId, focused, onStatus, theme }: { sessionId?: string; focused?: boolean; onStatus: (message: string) => void; theme: Theme }) {
  const ref = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    if (!ref.current) return;
    const host = ref.current;
    const terminal = new Terminal({
      cursorBlink: true,
      // System monospace first so first fit matches real glyphs (custom fonts may load late).
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 10000,
      allowProposedApi: true,
      theme: terminalTheme(themeRef.current),
      convertEol: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;

    const currentApi = api();
    let disposed = false;
    let fitFrame = 0;

    const resize = () => {
      if (disposed || !host.isConnected) return;
      // FitAddon needs a real box; skip until layout has settled.
      if (host.clientWidth < 20 || host.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (currentApi && terminal.cols > 0 && terminal.rows > 0) {
        if (sessionId) currentApi.resize(sessionId, terminal.cols, terminal.rows);
      }
    };

    const scheduleFit = () => {
      cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        resize();
        // Second pass after Chrome commits flex layout / font metrics.
        fitFrame = requestAnimationFrame(resize);
      });
    };

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

    // Linux terminal conventions: Ctrl+Shift+C / Ctrl+Shift+V.
    // Keep Ctrl+C as interrupt by only handling the Shift variants.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || !event.shiftKey) return true;

      if (key === 'c') {
        const selection = terminal.getSelection();
        if (selection) {
          void currentApi.copyText(selection).catch((error) => {
            statusRef.current(error instanceof Error ? error.message : String(error));
          });
        }
        return false;
      }

      if (key === 'v') {
        void currentApi.readText()
          .then((text) => {
            if (!text) return;
            // Prefer xterm paste so bracketed-paste mode is honored when available.
            if (typeof terminal.paste === 'function') {
              terminal.paste(text);
            } else {
              if (sessionId) currentApi.write(sessionId, text);
            }
          })
          .catch((error) => {
            statusRef.current(error instanceof Error ? error.message : String(error));
          });
        return false;
      }

      return true;
    });

    if (typeof terminal.onSelectionChange === 'function') {
      terminal.onSelectionChange(() => {
        const selection = terminal.getSelection();
        if (selection) {
          void currentApi.copyText(selection).catch(() => undefined);
        }
      });
    }

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
      void currentApi.attachSession(sessionId).then((attached) => {
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
      input.dispose();
      removeData();
      removeStatus();
      observer.disconnect();
      window.removeEventListener('resize', scheduleFit);
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [sessionId]);

  // Theme is a mutable xterm option. Rebuilding the Terminal to restyle it
  // would dispose the renderer and drop the pane's scrollback — the same
  // content loss the layout code deliberately avoids.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (focused) terminalRef.current?.focus();
  }, [focused]);

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
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return window.localStorage.getItem('zerog-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => {
    const initial = makeWorkspace('Workspace');
    return [initial];
  });
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => workspaces[0]?.id ?? '');
  const [active, setActive] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('terminals');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [overview, setOverview] = useState(false);
  const [layout, setLayout] = useState<Layout>('stack');
  const [focusedSessionId, setFocusedSessionId] = useState<string>();
  const [maximizedSessionId, setMaximizedSessionId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('Workspace');
  const [localName, setLocalName] = useState('term');
  const [sshName, setSshName] = useState('');
  const [sshTarget, setSshTarget] = useState('');
  const [approval, setApproval] = useState<{ command: string; explanation: string } | null>(null);
  const [voice, setVoice] = useState<{ status: VoiceStatus; sessionId: string | null }>({ status: 'idle', sessionId: null });
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const voiceWorkerRef = useRef<Worker | null>(null);
  const voiceTargetRef = useRef<string | null>(null);
  const voiceLimitRef = useRef<number | undefined>(undefined);
  const [localBackends, setLocalBackends] = useState<ShellBackend[]>([]);
  const [selectedBackend, setSelectedBackend] = useState<LocalBackend>('bash');
  const [wslDistribution, setWslDistribution] = useState<string>('');
  const [wslDistributions, setWslDistributions] = useState<string[]>([]);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [knownConnections, setKnownConnections] = useState<KnownConnection[]>([]);
  const [remoteScreenEntries, setRemoteScreenEntries] = useState<Array<{ session: SessionInfo; connection: KnownConnection }>>([]);
  const [remoteScreensLoading, setRemoteScreensLoading] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('zerog-theme', theme);
    } catch {
      // Theme still applies for this session when storage is unavailable.
    }
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
    const sshHost = (active?.kind === 'ssh' ? active.host : '') || (focusedSessionId ? sessions.find((s) => s.id === focusedSessionId)?.host : '') || '';
    const matching = sshHost ? knownConnections.filter((connection) => connection.hostName === sshHost || connection.alias === sshHost) : [];
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (voice.status === 'listening') {
          event.preventDefault();
          cancelVoice();
          setStatus('Voice cancelled');
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
        setLocalName(nextTerminalName(activeWorkspace?.name ?? 'term', workspaceSessions));
        setModal('local');
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overview, approval, modal, voice.status, workspaces, activeWorkspace, workspaceSessions]);

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
      currentApi.write(attached.id, `${screenCommand}\r`);
      setStatus(`Connected to ${session.name} on ${connection.alias}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const openNewWorkspace = () => {
    setWorkspaceName(nextWorkspaceName(workspaces));
    setModal('workspace');
  };

  const openNewLocalTerminal = () => {
    setLocalName(nextTerminalName(activeWorkspace?.name ?? 'term', workspaceSessions));
    setSelectedBackend('bash');
    setWslDistribution('');
    setModal('local');
  };

  const renderScreensTab = () => {
    const sshHost = (active?.kind === 'ssh' ? active.host : '') || (focusedSessionId ? sessions.find((s) => s.id === focusedSessionId)?.host : '') || '';
    const hostGroups: Record<string, Array<{ session: SessionInfo; connection: KnownConnection }>> = sshHost
      ? remoteScreenEntries
          .filter((entry) => entry.connection.hostName === sshHost || entry.connection.alias === sshHost)
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
                  const screenCommand = args && dashDashIndex > 0 ? args.slice(dashDashIndex + 1).join(' ') : `screen -x ${session.screenName ?? session.name}`;
                  currentApi.write(attached.id, `${screenCommand}\r`);
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

  const ensureVoiceWorker = () => {
    if (!voiceWorkerRef.current) {
      const worker = new Worker(new URL('./voice-worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => {
        const data = event.data as
          | { type: 'loading'; progress: number | null }
          | { type: 'result'; text: string }
          | { type: 'error'; message: string };
        if (data.type === 'result') {
          const target = voiceTargetRef.current;
          voiceTargetRef.current = null;
          setVoice({ status: 'idle', sessionId: null });
          if (data.text && target) {
            api()?.write(target, data.text);
            setStatus(`Voice: "${data.text}"`);
          } else {
            setStatus('Voice: nothing transcribed');
          }
        } else if (data.type === 'error') {
          voiceTargetRef.current = null;
          setVoice({ status: 'idle', sessionId: null });
          setStatus(`Voice error: ${data.message}`);
        } else if (data.type === 'loading' && typeof data.progress === 'number') {
          setStatus(`Loading speech model… ${Math.round(data.progress)}%`);
        }
      };
      voiceWorkerRef.current = worker;
    }
    return voiceWorkerRef.current;
  };

  const cancelVoice = () => {
    window.clearTimeout(voiceLimitRef.current);
    recorderRef.current?.cancel();
    recorderRef.current = null;
    voiceTargetRef.current = null;
    setVoice({ status: 'idle', sessionId: null });
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
    if (!audio || isMostlySilence(audio)) {
      voiceTargetRef.current = null;
      setVoice({ status: 'idle', sessionId: null });
      setStatus('Voice: no speech detected');
      return;
    }
    ensureVoiceWorker().postMessage({ type: 'transcribe', audio }, [audio.buffer]);
  };

  const toggleVoice = async (session: SessionInfo) => {
    if (voice.status === 'listening' && voice.sessionId === session.id) {
      await finishListening();
      return;
    }
    if (voice.status !== 'idle') return;
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
    setFocusedSessionId(session.id);
    window.clearTimeout(voiceLimitRef.current);
    voiceLimitRef.current = window.setTimeout(() => void finishListening(), MAX_UTTERANCE_SECONDS * 1000);
    setStatus(`Listening on ${session.name}… click the mic again or press Esc to finish`);
  };

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
              if (currentApi) setApproval(await currentApi.requestAiCommand());
            }}
          >
            <Icon name="spark" />
            <span>Suggest</span>
          </button>
          <button
            type="button"
            className="bar-button theme-button"
            onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            aria-pressed={theme === 'light'}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
          </button>
          <button type="button" className="avatar" title="Settings">S</button>
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
          <button type="button" className="rail-button" onClick={() => setModal('ssh')} title="Connect SSH">
            <Icon name="ssh" />
          </button>
          <button type="button" className="rail-button" title="Settings">
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
                  <button type="button" className="session-row" key={connection.alias} onClick={() => { setSshTarget(connection.hostName ?? connection.alias); setModal('ssh'); }}>
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
              <button type="button" className="drawer-action" onClick={() => setModal('ssh')}>
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
                    theme={theme}
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
        <div className="overview-layer" onClick={() => setOverview(false)}>
          <section className="overview" onClick={(event) => event.stopPropagation()}>
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
              <button type="button" onClick={() => { setOverview(false); setModal('ssh'); }}>Connect SSH</button>
              <button type="button" onClick={() => { setOverview(false); openNewWorkspace(); }}>+ Workspace</button>
              <span className="overview-hint">Press Esc to close</span>
            </div>
          </section>
        </div>
      )}

      {historyOpen && (
        <div className="history-layer" onClick={() => setHistoryOpen(false)}>
          <div className="history-popover" role="dialog" aria-label="Session history" onClick={(event) => event.stopPropagation()}>
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
        <div className="modal-layer" onClick={() => setModal(null)}>
          <form
            className="modal-card"
            onClick={(event) => event.stopPropagation()}
            onSubmit={modal === 'workspace' ? createWorkspace : modal === 'local' ? createLocal : createSsh}
          >
            <div className="modal-head">
              <div>
                <span className="eyebrow">
                  {modal === 'workspace' ? 'WORKSPACE' : modal === 'local' ? 'LOCAL TERMINAL' : 'REMOTE SESSION'}
                </span>
                <h2>
                  {modal === 'workspace' ? 'New workspace' : modal === 'local' ? 'New terminal' : 'Connect SSH'}
                </h2>
              </div>
              <button type="button" className="close-button" onClick={() => setModal(null)}>Esc</button>
            </div>

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

            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>Cancel</button>
              <button className="primary-button" disabled={busy} type="submit">
                {busy
                  ? 'Working…'
                  : modal === 'workspace'
                    ? 'Create workspace'
                    : modal === 'local'
                      ? 'Open terminal'
                      : 'Connect'}
              </button>
            </div>
          </form>
        </div>
      )}

      {approval && (
        <div className="modal-layer" onClick={() => setApproval(null)}>
          <div className="modal-card approval-card" onClick={(event) => event.stopPropagation()}>
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
