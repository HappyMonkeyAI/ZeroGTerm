import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import type { SessionInfo } from '../shared/types';

type Layout = 'stack' | 'split-v' | 'split-h' | 'grid';
type ModalKind = 'workspace' | 'local' | 'ssh' | null;
type Theme = 'dark' | 'light';

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
    default:
      return <span className="icon" aria-hidden="true">•</span>;
  }
}

function TerminalView({ onStatus, theme }: { onStatus: (message: string) => void; theme: Theme }) {
  const ref = useRef<HTMLDivElement>(null);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;

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
      theme: terminalTheme(theme),
      convertEol: true,
      allowProposedApi: false
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);

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
        currentApi.resize(terminal.cols, terminal.rows);
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
        terminal.dispose();
      };
    }

    const removeData = currentApi.onData((data) => terminal.write(data));
    const removeStatus = currentApi.onStatus((status) => {
      statusRef.current(status);
      // Refit after connection changes — wrong rows make prompts appear mid-pane.
      scheduleFit();
    });
    const input = terminal.onData((data) => currentApi.write(data));

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
              currentApi.write(text);
            }
          })
          .catch((error) => {
            statusRef.current(error instanceof Error ? error.message : String(error));
          });
        return false;
      }

      return true;
    });

    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(host);
    window.addEventListener('resize', scheduleFit);
    document.fonts?.ready?.then(() => {
      if (!disposed) scheduleFit();
    }).catch(() => undefined);

    scheduleFit();
    terminal.writeln('\x1b[90mZeroG Terminal\x1b[0m');
    terminal.writeln('\x1b[90mSelect a session or create a local/SSH connection.\x1b[0m');

    return () => {
      disposed = true;
      cancelAnimationFrame(fitFrame);
      input.dispose();
      removeData();
      removeStatus();
      observer.disconnect();
      window.removeEventListener('resize', scheduleFit);
      terminal.dispose();
    };
  }, [theme]);

  return <div className="terminal" ref={ref} />;
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
  const [modal, setModal] = useState<ModalKind>(null);
  const [overview, setOverview] = useState(false);
  const [layout, setLayout] = useState<Layout>('stack');
  const [workspaceName, setWorkspaceName] = useState('Workspace');
  const [localName, setLocalName] = useState('term');
  const [sshName, setSshName] = useState('');
  const [sshTarget, setSshTarget] = useState('');
  const [approval, setApproval] = useState<{ command: string; explanation: string } | null>(null);

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
    if (!currentApi) {
      setStatus('Preload API unavailable');
      return;
    }
    try {
      const items = await currentApi.listSessions();
      setSessions(items);
      setStatus(items.length ? `${items.length} session${items.length === 1 ? '' : 's'}` : 'No sessions');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!active && workspaceSessions.length) {
      setActive(workspaceSessions[0]);
    }
  }, [active, workspaceSessions]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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
        setLayout((value) => (value === 'stack' ? 'split-v' : 'stack'));
      }
      if (key === 'b') {
        event.preventDefault();
        setDrawerCollapsed((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overview, approval, modal, workspaces, activeWorkspace, workspaceSessions]);

  const attach = async (session: SessionInfo) => {
    const currentApi = api();
    if (!currentApi) return setStatus('Preload API unavailable');
    setBusy(true);
    setActive(session);
    try {
      const attached = await currentApi.attachSession(session.id);
      setActive(attached);
      setSessions((current) => current.map((item) => (item.id === attached.id ? attached : item)));
      setStatus(
        attached.persistence === 'process'
          ? `${attached.host} · ${attached.name} · process only (install screen for persistence)`
          : `${attached.host} · ${attached.name}`
      );
      setOverview(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
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
    setBusy(true);
    try {
      const session = await currentApi.createLocalSession({ name: localName });
      setSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
      claimSession(session);
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
    setBusy(true);
    try {
      const session = await currentApi.createSshSession({ name: sshName || undefined, target: sshTarget });
      setSessions((current) => [...current.filter((item) => item.id !== session.id), session]);
      claimSession(session);
      setModal(null);
      await attach(session);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const openNewWorkspace = () => {
    setWorkspaceName(nextWorkspaceName(workspaces));
    setModal('workspace');
  };

  const openNewLocalTerminal = () => {
    setLocalName(nextTerminalName(activeWorkspace?.name ?? 'term', workspaceSessions));
    setModal('local');
  };

  const paneClass =
    layout === 'split-v'
      ? 'pane-grid split-v'
      : layout === 'split-h'
        ? 'pane-grid split-h'
        : layout === 'grid'
          ? 'pane-grid grid'
          : 'pane-grid';
  const paneCount = layout === 'stack' ? 1 : layout === 'grid' ? 4 : 2;

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
                  className="square-button"
                  onClick={openNewLocalTerminal}
                  title="New local terminal"
                >
                  <Icon name="plus" />
                </button>
              </div>
            </div>

            <div className="drawer-tools">
              <button type="button" className="drawer-tool active">
                Terminals <span>{workspaceSessions.length}</span>
              </button>
              <button type="button" className="drawer-tool" onClick={() => setModal('ssh')}>
                Remote
              </button>
            </div>

            <div className="session-list">
              {workspaceSessions.length ? (
                workspaceSessions.map((session) => (
                  <button
                    type="button"
                    className={`session-row ${active?.id === session.id ? 'active' : ''}`}
                    key={session.id}
                    onClick={() => void attach(session)}
                  >
                    <span className={`status-dot ${session.status}`} />
                    <span className="session-copy">
                      <b>{session.name}</b>
                      <small>
                        {session.kind === 'ssh'
                          ? `SSH · ${session.host}`
                          : session.persistence === 'process'
                            ? 'local · process only'
                            : `local · ${session.cwd}`}
                      </small>
                    </span>
                    <span className="session-state">{session.status === 'connected' ? '●' : '○'}</span>
                  </button>
                ))
              ) : (
                <div className="session-empty">
                  <b>No terminals yet</b>
                  <small>Add a local terminal or SSH connection to this workspace.</small>
                </div>
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
              <button type="button" className={layout === 'stack' ? 'layout-button active' : 'layout-button'} onClick={() => setLayout('stack')} title="Stack">
                <Icon name="stack" />
              </button>
              <button type="button" className={layout === 'split-v' ? 'layout-button active' : 'layout-button'} onClick={() => setLayout('split-v')} title="Vertical split">
                <Icon name="split-v" />
              </button>
              <button type="button" className={layout === 'split-h' ? 'layout-button active' : 'layout-button'} onClick={() => setLayout('split-h')} title="Horizontal split">
                <Icon name="split-h" />
              </button>
              <button type="button" className={layout === 'grid' ? 'layout-button active' : 'layout-button'} onClick={() => setLayout('grid')} title="Grid">
                <Icon name="grid" />
              </button>
            </div>
          </div>

          <div className={paneClass}>
            {Array.from({ length: paneCount }, (_, index) =>
              index === 0 ? (
                <article className="pane terminal-pane" key="terminal">
                  <div className="pane-title">
                    <span>
                      <span className="pane-live" /> {active?.name ?? 'TERMINAL'}
                    </span>
                    <span className="pane-actions">{busy ? 'connecting…' : 'bash / ssh'} ···</span>
                  </div>
                  <TerminalView onStatus={setStatus} theme={theme} />
                </article>
              ) : (
                <PanePlaceholder key={index} index={index + 1} onCreate={openNewLocalTerminal} />
              )
            )}
          </div>

          <footer className="status-bar">
            <span>ZeroG</span>
            <span className="status-separator" />
            <span>{activeWorkspace?.name ?? 'Workspace'}</span>
            <span className="status-separator" />
            <span>{layout === 'stack' ? '1 pane' : `${paneCount} panes`}</span>
            <span className="status-separator" />
            <span>Esc closes overlays · ⌘⇧B sidebar</span>
            <span className="status-spacer" />
            <span>{active ? `${active.kind === 'ssh' ? 'SSH' : 'SCREEN'} · persistent` : 'no connection'}</span>
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
                <p>Start a persistent named screen session inside “{activeWorkspace?.name ?? 'this workspace'}”.</p>
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
                  api()?.write(`${approval.command}\r`);
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

createRoot(document.getElementById('root')!).render(<App />);
