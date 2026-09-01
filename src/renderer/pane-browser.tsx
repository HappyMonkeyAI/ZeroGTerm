// The directory browser that sits beside a terminal inside its own pane.
//
// Deliberately not the transfer panel. That one moves files and opens over the
// whole workspace; this one exists to answer "what is in here, and take me
// there". So directories are the only actionable rows, files are shown greyed
// because knowing they are there is most of what orients you, and there is no
// selection, no upload, and no delete.
//
// It lists through whichever source the pane implies — sftp for an SSH pane, the
// local filesystem for a local one, including a WSL pane by way of the share
// path pane-directory builds. Neither is a new IPC call.

import React, { useCallback, useEffect, useState } from 'react';
import { Icon } from './icons';
import { isNavigable } from './sftp-view';
import { joinPath, parentOf, type PathKind } from './pane-directory';
import type { DirectoryListing, FileEntry, SessionInfo } from '../shared/types';

export type PaneBrowserProps = {
  session: SessionInfo;
  /** Where to list. Null while the shell has not said anywhere usable. */
  path: string | null;
  pathKind: PathKind;
  /** What the shell reports, so the header can say when the two differ. */
  shellPath: string | null;
  list: (path: string) => Promise<DirectoryListing>;
  /** Chosen by a double-click. The caller decides whether the shell can move. */
  onOpen: (path: string) => void;
  /** Navigating without moving the shell, which is the browser's own business. */
  onBrowse: (path: string) => void;
  onClose: () => void;
};

type State =
  | { phase: 'idle' }
  | { phase: 'loading'; path: string }
  | { phase: 'ready'; path: string; listing: DirectoryListing }
  | { phase: 'failed'; path: string; message: string };

export function PaneBrowser({
  session,
  path,
  pathKind,
  shellPath,
  list,
  onOpen,
  onBrowse,
  onClose
}: PaneBrowserProps) {
  const [state, setState] = useState<State>({ phase: 'idle' });

  const load = useCallback(
    (target: string) => {
      let cancelled = false;
      setState({ phase: 'loading', path: target });
      list(target)
        .then((listing) => {
          if (!cancelled) setState({ phase: 'ready', path: target, listing });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setState({ phase: 'failed', path: target, message: error instanceof Error ? error.message : String(error) });
        });
      return () => {
        cancelled = true;
      };
    },
    [list]
  );

  useEffect(() => {
    if (!path) {
      setState({ phase: 'idle' });
      return;
    }
    return load(path);
  }, [path, load]);

  const parent = path ? parentOf(path, pathKind) : null;
  const entries = state.phase === 'ready' ? state.listing.entries : [];
  // Directories first, then files, each alphabetically — the order that makes a
  // browser for navigating rather than for reading a directory's raw order.
  const sorted = [...entries].sort((a, b) => {
    const aDir = isNavigable(a) ? 0 : 1;
    const bDir = isNavigable(b) ? 0 : 1;
    return aDir === bDir ? a.name.localeCompare(b.name) : aDir - bDir;
  });

  return (
    <div className="pane-browser" aria-label={`Directories on ${session.host}`}>
      <div className="pane-browser-head">
        <span className="pane-browser-path" title={state.phase === 'ready' ? state.listing.path : (path ?? '')}>
          {shellPath ?? path ?? 'waiting for the shell'}
        </span>
        <span className="pane-browser-actions">
          <button
            type="button"
            className="pane-browser-icon"
            disabled={state.phase !== 'ready' && state.phase !== 'failed'}
            onClick={() => path && load(path)}
            title="Refresh"
            aria-label="Refresh"
          >
            <Icon name="refresh" />
          </button>
          <button type="button" className="pane-browser-icon" onClick={onClose} title="Close the browser" aria-label="Close the browser">
            <Icon name="x" />
          </button>
        </span>
      </div>

      <div className="pane-browser-list">
        {state.phase === 'idle' ? (
          <p className="pane-browser-note">
            {/* The honest answer rather than a guessed directory. cwd-tracker
                reports where a shell is from OSC 7 or its prompt; until one of
                those says something, there is nowhere to list. */}
            This pane has not said where it is yet. Run a command, or add shell integration in Settings.
          </p>
        ) : state.phase === 'failed' ? (
          <p className="pane-browser-note pane-browser-error">{state.message}</p>
        ) : (
          <>
            {/* Always offered, and absent only at a root — which for a WSL pane
                is the distribution, not the list of distributions above it. */}
            {parent ? (
              <button
                type="button"
                className="pane-browser-row pane-browser-parent"
                onDoubleClick={() => onOpen(parent)}
                onClick={() => onBrowse(parent)}
                title="Up one directory — double-click to take the shell there"
              >
                <Icon name="level-up" />
                <span className="pane-browser-name">..</span>
              </button>
            ) : null}

            {sorted.map((entry) => (
              <BrowserRow key={entry.name} entry={entry} path={path ?? ''} pathKind={pathKind} onOpen={onOpen} onBrowse={onBrowse} />
            ))}

            {state.phase === 'ready' && !sorted.length ? (
              <p className="pane-browser-note">Nothing here.</p>
            ) : null}
            {state.phase === 'loading' ? <p className="pane-browser-note">Listing…</p> : null}
          </>
        )}
      </div>

      <small className="pane-browser-foot">Double-click a folder to take the shell there.</small>
    </div>
  );
}

function BrowserRow({
  entry,
  path,
  pathKind,
  onOpen,
  onBrowse
}: {
  entry: FileEntry;
  path: string;
  pathKind: PathKind;
  onOpen: (path: string) => void;
  onBrowse: (path: string) => void;
}) {
  const navigable = isNavigable(entry);
  const child = joinPath(path, entry.name, pathKind);
  return (
    <button
      type="button"
      className={`pane-browser-row ${navigable ? '' : 'pane-browser-file'}`}
      disabled={!navigable}
      onDoubleClick={() => navigable && onOpen(child)}
      onClick={() => navigable && onBrowse(child)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !navigable) return;
        event.preventDefault();
        onOpen(child);
      }}
      title={navigable ? `${entry.name} — double-click to take the shell there` : entry.name}
    >
      <Icon name={navigable ? 'folder' : 'file'} />
      <span className="pane-browser-name">{entry.name}</span>
      {entry.kind === 'symlink' ? <span className="pane-browser-kind">link</span> : null}
    </button>
  );
}
