// The transfer panel: local files on the left, the active SSH session's host on
// the right, and the two directions of copying between them.
//
// It is an overlay rather than a second window so that it shares the workspace's
// session state directly — the host it talks to is the session the user is
// working in, and the directory it opens at is the one that session's shell is
// standing in.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DirectoryListing, FileEntry, SessionInfo, SftpPrompt, SftpSessionInfo, TerminalApi } from '../shared/types';
import { baseName, formatModified, formatSize, joinLocal, joinRemote, parentLocal, parentRemote } from '../shared/files';
import { Icon } from './icons';
import { resolveStartPath } from './cwd-tracker';
import { isNavigable, nextSelection, transferLabel, transferable } from './sftp-view';
import type { BackdropDismissHandlers } from './backdrop-dismiss';

type Side = 'local' | 'remote';
type Progress = { name: string; percent: number; detail: string };
type Editing = { side: Side; entry: FileEntry; value: string };
type Creating = { side: Side; value: string };
type Pending = { side: Side; entry: FileEntry };

export function SftpPanel({
  session,
  target,
  api,
  onClose,
  backdrop
}: {
  session: SessionInfo;
  /** The validated SSH destination, resolved by the caller from the session. */
  target: string;
  api: TerminalApi;
  onClose: () => void;
  backdrop: BackdropDismissHandlers;
}) {
  const [local, setLocal] = useState<DirectoryListing | null>(null);
  const [remote, setRemote] = useState<DirectoryListing | null>(null);
  const [connection, setConnection] = useState<SftpSessionInfo | null>(null);
  const [busy, setBusy] = useState<{ local: boolean; remote: boolean }>({ local: true, remote: true });
  const [selection, setSelection] = useState<{ local: Set<string>; remote: Set<string> }>({ local: new Set(), remote: new Set() });
  const [pathDraft, setPathDraft] = useState<{ local: string; remote: string }>({ local: '', remote: '' });
  const [notice, setNotice] = useState('Connecting…');
  const [failure, setFailure] = useState<{ local?: string; remote?: string }>({});
  const [progress, setProgress] = useState<Progress | null>(null);
  const [prompt, setPrompt] = useState<SftpPrompt | null>(null);
  const [answer, setAnswer] = useState('');
  const [creating, setCreating] = useState<Creating | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  // The connection id is needed to answer a password prompt, which arrives
  // *while* the open call is still pending — so it is held in a ref that either
  // the prompt event or the resolved open call can fill, whichever comes first.
  const connectionId = useRef<string | null>(null);
  // The panes' current paths, so a refresh triggered from a handler created
  // several renders ago still reloads the folder on screen.
  const localPathRef = useRef<string | undefined>(undefined);
  const remotePathRef = useRef<string | undefined>(undefined);
  localPathRef.current = local?.path;
  remotePathRef.current = remote?.path;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const report = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setNotice(message);
    return message;
  }, []);

  const loadLocal = useCallback(async (path?: string) => {
    setBusy((current) => ({ ...current, local: true }));
    try {
      const listing = await api.listLocalDirectory(path);
      if (!mounted.current) return;
      setLocal(listing);
      setPathDraft((current) => ({ ...current, local: listing.path }));
      setSelection((current) => ({ ...current, local: new Set() }));
      setFailure((current) => ({ ...current, local: undefined }));
    } catch (error) {
      if (!mounted.current) return;
      setFailure((current) => ({ ...current, local: report(error) }));
    } finally {
      if (mounted.current) setBusy((current) => ({ ...current, local: false }));
    }
  }, [api, report]);

  const loadRemote = useCallback(async (path?: string) => {
    const id = connectionId.current;
    if (!id) return;
    setBusy((current) => ({ ...current, remote: true }));
    try {
      const listing = await api.sftpList(id, path);
      if (!mounted.current) return;
      setRemote(listing);
      setPathDraft((current) => ({ ...current, remote: listing.path }));
      setSelection((current) => ({ ...current, remote: new Set() }));
      setFailure((current) => ({ ...current, remote: undefined }));
    } catch (error) {
      if (!mounted.current) return;
      setFailure((current) => ({ ...current, remote: report(error) }));
    } finally {
      if (mounted.current) setBusy((current) => ({ ...current, remote: false }));
    }
  }, [api, report]);

  // Events from the transfer connection: the questions it needs answered, the
  // progress of a running copy, and its death.
  useEffect(() => {
    return api.onSftpEvent?.((event) => {
      if (!mounted.current) return;
      const id = connectionId.current;
      // Before the open call resolves there is no id to match on, and there is
      // only ever one connecting panel — so an unmatched prompt is this one's.
      if (event.type === 'prompt') {
        if (id && event.prompt.sessionId !== id) return;
        connectionId.current = event.prompt.sessionId;
        setPrompt(event.prompt);
        setAnswer('');
        return;
      }
      if (id && event.sessionId !== id) return;
      if (event.type === 'progress') setProgress({ name: event.name, percent: event.percent, detail: event.detail });
      if (event.type === 'status') setNotice(event.message);
      if (event.type === 'closed') {
        connectionId.current = null;
        setConnection(null);
        setFailure((current) => ({ ...current, remote: event.message }));
        setNotice(event.message);
      }
    });
  }, [api]);

  // Open both sides once. The local pane does not wait for the remote one: a
  // host asking for a password should not leave the user staring at two empty
  // panes when half of what they need is already available.
  useEffect(() => {
    void loadLocal();
    const start = resolveStartPath(session.cwd);
    let cancelled = false;
    (async () => {
      try {
        const opened = await api.sftpOpen(target, start.absolute);
        if (cancelled || !mounted.current) return;
        connectionId.current = opened.id;
        setConnection(opened);
        setPrompt(null);
        setNotice(`Connected to ${opened.target}`);
        // A `~`-relative reading from the shell's prompt only becomes a real
        // path once the login directory is known, which it now is.
        await loadRemote(start.homeRelative ? joinRemote(opened.cwd, start.homeRelative) : undefined);
      } catch (error) {
        if (cancelled || !mounted.current) return;
        setPrompt(null);
        setBusy((current) => ({ ...current, remote: false }));
        setFailure((current) => ({ ...current, remote: report(error) }));
      }
    })();
    return () => { cancelled = true; };
    // Opening is a one-shot: the panel is remounted when the session changes.
  }, []);

  const refresh = useCallback((side: Side) => (side === 'local' ? loadLocal(localPathRef.current) : loadRemote(remotePathRef.current)), [loadLocal, loadRemote]);

  const navigate = (side: Side, path: string) => (side === 'local' ? loadLocal(path) : loadRemote(path));

  const localSelected = useMemo(() => transferable(local?.entries ?? [], selection.local), [local, selection.local]);
  const remoteSelected = useMemo(() => transferable(remote?.entries ?? [], selection.remote), [remote, selection.remote]);
  const transferring = progress !== null;

  const runTransfer = async (direction: 'upload' | 'download') => {
    const id = connectionId.current;
    if (!id || !local || !remote) return;
    const files = direction === 'upload' ? localSelected : remoteSelected;
    if (!files.length) return;
    setProgress({ name: files[0].name, percent: 0, detail: 'starting' });
    let moved = 0;
    try {
      for (const file of files) {
        setNotice(`${direction === 'upload' ? 'Uploading' : 'Downloading'} ${file.name}…`);
        if (direction === 'upload') await api.sftpUpload(id, joinLocal(local.path, file.name), remote.path);
        else await api.sftpDownload(id, joinRemote(remote.path, file.name), local.path);
        moved += 1;
      }
      setNotice(`${direction === 'upload' ? 'Uploaded' : 'Downloaded'} ${moved} ${moved === 1 ? 'file' : 'files'}.`);
    } catch (error) {
      // Say how far it got: with several files selected, "failed" alone does not
      // tell the user which ones are now on the other side.
      const message = report(error);
      setNotice(`${message} (${moved} of ${files.length} transferred)`);
    } finally {
      if (mounted.current) {
        setProgress(null);
        // Refresh the receiving side only: it is the one that changed.
        await refresh(direction === 'upload' ? 'remote' : 'local');
      }
    }
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!creating) return;
    const name = creating.value.trim();
    const side = creating.side;
    if (!name) return;
    try {
      if (side === 'local' && local) await api.createLocalDirectory(joinLocal(local.path, name));
      else if (side === 'remote' && remote && connectionId.current) await api.sftpMkdir(connectionId.current, joinRemote(remote.path, name));
      setCreating(null);
      setNotice(`Created ${name}`);
      await refresh(side);
    } catch (error) {
      report(error);
    }
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const name = editing.value.trim();
    const { side, entry } = editing;
    if (!name || name === entry.name) { setEditing(null); return; }
    try {
      if (side === 'local' && local) await api.renameLocalEntry(joinLocal(local.path, entry.name), joinLocal(local.path, name));
      else if (side === 'remote' && remote && connectionId.current) await api.sftpRename(connectionId.current, joinRemote(remote.path, entry.name), joinRemote(remote.path, name));
      setEditing(null);
      setNotice(`Renamed to ${name}`);
      await refresh(side);
    } catch (error) {
      report(error);
    }
  };

  const confirmDelete = async () => {
    if (!pending) return;
    const { side, entry } = pending;
    try {
      if (side === 'local' && local) await api.removeLocalEntry(joinLocal(local.path, entry.name), entry.kind);
      else if (side === 'remote' && remote && connectionId.current) await api.sftpRemove(connectionId.current, joinRemote(remote.path, entry.name), entry.kind);
      setPending(null);
      setNotice(`Deleted ${entry.name}`);
      await refresh(side);
    } catch (error) {
      report(error);
    }
  };

  const submitAnswer = async (event: FormEvent) => {
    event.preventDefault();
    const id = connectionId.current;
    if (!id || !prompt) return;
    const value = prompt.kind === 'confirm' ? 'yes' : answer;
    setPrompt(null);
    setAnswer('');
    setNotice(prompt.kind === 'confirm' ? 'Accepting host key…' : 'Authenticating…');
    try {
      await api.sftpAnswerPrompt(id, value);
    } catch (error) {
      report(error);
    }
  };

  /**
   * Back out of a question.
   *
   * A host-key question has a real answer for this: "no" makes the client refuse
   * the connection, which is exactly what the user just said. Cancelling a
   * password has no such answer — sending anything would spend one of the host's
   * authentication attempts on a guess nobody made — so the connection is closed
   * instead.
   */
  const rejectPrompt = async (kind: SftpPrompt['kind']) => {
    const id = connectionId.current;
    setPrompt(null);
    setAnswer('');
    setNotice(kind === 'confirm' ? 'Host key rejected.' : 'Cancelled. The transfer connection was closed.');
    if (!id) return;
    try {
      if (kind === 'confirm') await api.sftpAnswerPrompt(id, 'no');
      else await api.sftpClose(id);
    } catch {
      /* the connection is going away either way */
    }
  };

  const openEntry = (side: Side, entry: FileEntry) => {
    if (!isNavigable(entry)) return;
    const base = side === 'local' ? local?.path : remote?.path;
    if (!base) return;
    void navigate(side, side === 'local' ? joinLocal(base, entry.name) : joinRemote(base, entry.name));
  };

  const singleSelected = (side: Side): FileEntry | null => {
    const names = side === 'local' ? selection.local : selection.remote;
    const entries = (side === 'local' ? local?.entries : remote?.entries) ?? [];
    if (names.size !== 1) return null;
    return entries.find((entry) => names.has(entry.name)) ?? null;
  };

  const renderPane = (side: Side) => {
    const listing = side === 'local' ? local : remote;
    const selected = side === 'local' ? selection.local : selection.remote;
    const error = side === 'local' ? failure.local : failure.remote;
    const loading = side === 'local' ? busy.local : busy.remote;
    const chosen = singleSelected(side);
    const disabled = side === 'remote' && !connection;

    return (
      <section className={`sftp-pane sftp-pane-${side}`}>
        <header className="sftp-pane-head">
          <span className="eyebrow">{side === 'local' ? 'THIS COMPUTER' : session.host.toUpperCase()}</span>
          <div className="sftp-pane-tools">
            <button
              type="button"
              title="Parent folder"
              aria-label={`${side} parent folder`}
              disabled={!listing || loading}
              onClick={() => listing && void navigate(side, side === 'local' ? parentLocal(listing.path) : parentRemote(listing.path))}
            >
              <Icon name="level-up" />
            </button>
            <button type="button" title="Refresh" aria-label={`Refresh ${side}`} disabled={loading || disabled} onClick={() => void refresh(side)}>
              <Icon name="refresh" />
            </button>
            <button type="button" title="New folder" aria-label={`New folder on ${side}`} disabled={!listing || disabled} onClick={() => setCreating({ side, value: '' })}>
              <Icon name="folder-plus" />
            </button>
            <button
              type="button"
              title={chosen ? `Rename ${chosen.name}` : 'Select one item to rename'}
              aria-label={`Rename on ${side}`}
              disabled={!chosen || disabled}
              onClick={() => chosen && setEditing({ side, entry: chosen, value: chosen.name })}
            >
              <Icon name="pencil" />
            </button>
            <button
              type="button"
              className="sftp-danger"
              title={chosen ? `Delete ${chosen.name}` : 'Select one item to delete'}
              aria-label={`Delete on ${side}`}
              disabled={!chosen || disabled}
              onClick={() => chosen && setPending({ side, entry: chosen })}
            >
              <Icon name="trash" />
            </button>
          </div>
        </header>

        <form
          className="sftp-path"
          onSubmit={(event) => {
            event.preventDefault();
            const value = (side === 'local' ? pathDraft.local : pathDraft.remote).trim();
            if (value) void navigate(side, value);
          }}
        >
          <input
            value={side === 'local' ? pathDraft.local : pathDraft.remote}
            onChange={(event) => {
              const value = event.target.value;
              setPathDraft((current) => (side === 'local' ? { ...current, local: value } : { ...current, remote: value }));
            }}
            spellCheck={false}
            aria-label={`${side} path`}
            placeholder={side === 'local' ? 'Local folder' : 'Remote folder'}
            disabled={disabled}
          />
        </form>

        <div className="sftp-list" role="listbox" aria-label={`${side} files`} aria-busy={loading}>
          {error ? (
            <div className="sftp-empty sftp-error">
              <b>{side === 'local' ? 'Cannot read this folder' : 'No remote listing'}</b>
              <small>{error}</small>
            </div>
          ) : loading && !listing ? (
            <div className="sftp-empty"><b>{side === 'remote' && !connection ? 'Connecting…' : 'Loading…'}</b><small>{side === 'remote' ? `Opening SFTP to ${session.host}` : 'Reading the local folder'}</small></div>
          ) : listing && listing.entries.length ? (
            listing.entries.map((entry) => (
              <button
                type="button"
                role="option"
                aria-selected={selected.has(entry.name)}
                key={entry.name}
                className={`sftp-row ${selected.has(entry.name) ? 'selected' : ''} ${entry.kind === 'directory' ? 'is-directory' : ''}`}
                onClick={(event) => {
                  const additive = event.ctrlKey || event.metaKey;
                  setSelection((current) => (side === 'local'
                    ? { ...current, local: nextSelection(current.local, entry.name, additive) }
                    : { ...current, remote: nextSelection(current.remote, entry.name, additive) }));
                }}
                onDoubleClick={() => openEntry(side, entry)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || !isNavigable(entry)) return;
                  event.preventDefault();
                  openEntry(side, entry);
                }}
                title={entry.linkTarget ? `${entry.name} → ${entry.linkTarget}` : entry.name}
              >
                <Icon name={entry.kind === 'directory' ? 'folder' : entry.kind === 'symlink' ? 'link' : 'file'} />
                <span className="sftp-name">{entry.name}</span>
                <span className="sftp-size">{formatSize(entry)}</span>
                <span className="sftp-modified">{formatModified(entry.modified)}</span>
              </button>
            ))
          ) : (
            <div className="sftp-empty"><b>Empty folder</b><small>Nothing here to transfer.</small></div>
          )}
        </div>

        <footer className="sftp-pane-foot">
          {side === 'local' ? (
            <button
              type="button"
              className="primary-button"
              disabled={!localSelected.length || !connection || transferring}
              onClick={() => void runTransfer('upload')}
              title={localSelected.length ? `Copy to ${session.host}` : 'Select files to upload'}
            >
              <Icon name="arrow-up" /> {transferLabel('Upload', localSelected.length)}
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              disabled={!remoteSelected.length || !connection || transferring}
              onClick={() => void runTransfer('download')}
              title={remoteSelected.length ? 'Copy to this computer' : 'Select files to download'}
            >
              <Icon name="arrow-down" /> {transferLabel('Download', remoteSelected.length)}
            </button>
          )}
          <span className="sftp-count">{listing ? `${listing.entries.length} items` : ''}</span>
        </footer>
      </section>
    );
  };

  return (
    <div className="sftp-layer" role="presentation" {...backdrop}>
      <section className="sftp-panel" role="dialog" aria-label="Transfer files">
        <div className="sftp-head">
          <div>
            <span className="eyebrow">TRANSFER FILES</span>
            <h2>{session.name} · {session.host}</h2>
          </div>
          <button type="button" className="close-button" onClick={onClose}>Esc</button>
        </div>

        <div className="sftp-body">
          {renderPane('local')}
          {renderPane('remote')}
        </div>

        {prompt && (
          <form className="sftp-prompt" onSubmit={submitAnswer}>
            <span className="eyebrow warning-text">{prompt.kind === 'confirm' ? 'HOST KEY' : 'AUTHENTICATION'}</span>
            <pre>{prompt.text}</pre>
            {prompt.kind === 'confirm' ? (
              <div className="modal-actions">
                <button type="button" onClick={() => void rejectPrompt('confirm')}>Reject</button>
                <button type="submit" className="primary-button">Accept key</button>
              </div>
            ) : (
              <>
                <label>
                  {prompt.kind === 'passphrase' ? 'Key passphrase' : 'Password'}
                  <input
                    autoFocus
                    type="password"
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    // Never offered to a password manager and never stored: it
                    // is written to the ssh client and forgotten.
                    autoComplete="off"
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" onClick={() => void rejectPrompt(prompt.kind)}>Cancel</button>
                  <button type="submit" className="primary-button">Send</button>
                </div>
              </>
            )}
          </form>
        )}

        {creating && (
          <form className="sftp-inline-form" onSubmit={submitCreate}>
            <label>
              New folder in {creating.side === 'local' ? local?.path : remote?.path}
              <input autoFocus value={creating.value} onChange={(event) => setCreating({ ...creating, value: event.target.value })} required />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setCreating(null)}>Cancel</button>
              <button type="submit" className="primary-button">Create</button>
            </div>
          </form>
        )}

        {editing && (
          <form className="sftp-inline-form" onSubmit={submitRename}>
            <label>
              Rename {editing.entry.name}
              <input autoFocus value={editing.value} onChange={(event) => setEditing({ ...editing, value: event.target.value })} required />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="primary-button">Rename</button>
            </div>
          </form>
        )}

        {pending && (
          <div className="sftp-inline-form">
            <span className="eyebrow warning-text">CONFIRM DELETE</span>
            <p>
              Delete <b>{pending.entry.name}</b> from {pending.side === 'local' ? 'this computer' : session.host}?
              {pending.entry.kind === 'directory' ? ' Only an empty folder can be deleted here.' : ''}
            </p>
            <div className="modal-actions">
              <button type="button" autoFocus onClick={() => setPending(null)}>Cancel</button>
              <button type="button" className="primary-button sftp-danger-button" onClick={() => void confirmDelete()}>Delete</button>
            </div>
          </div>
        )}

        <footer className="sftp-foot">
          {progress ? (
            <div className="sftp-progress" role="progressbar" aria-valuenow={progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label={`Transferring ${progress.name}`}>
              <div className="sftp-progress-fill" style={{ width: `${progress.percent}%` }} />
              <span>{baseName(progress.name)} · {progress.percent}% · {progress.detail}</span>
            </div>
          ) : (
            <span className="sftp-notice">{notice}</span>
          )}
          <span className="sftp-hint">Double-click a folder to open · Ctrl-click to select several · Esc closes</span>
        </footer>
      </section>
    </div>
  );
}
