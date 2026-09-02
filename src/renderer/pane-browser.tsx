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
import { useRowActivation } from './row-activation';
import { isNavigable } from './sftp-view';
import { joinPath, parentOf, type PathKind } from './pane-directory';
import type { DirectoryListing, FileEntry, SessionInfo } from '../shared/types';

export type PaneBrowserProps = {
  session: SessionInfo;
  /** Where to list. Null while the shell has not said anywhere usable. */
  path: string | null;
  pathKind: PathKind;
  /**
   * The same place as `path`, named the way this pane's shell would name it —
   * a distro path rather than the `\\wsl.localhost\` share it is listed
   * through. Shown in the header, because that is the name the user would type.
   */
  shellPath: string | null;
  list: (path: string) => Promise<DirectoryListing>;
  /**
   * What the host is waiting to be asked, when a transfer connection is being
   * opened and has put a question. Shown, never answered: the transfer panel
   * owns that, with the key fingerprint beside the question.
   */
  question?: string | null;
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
  question,
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
        {question && state.phase === 'loading' ? (
          <p className="pane-browser-note pane-browser-asking">
            {question}
            <br />
            Answer it in the transfer panel (⇅), then refresh.
          </p>
        ) : state.phase === 'idle' ? (
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
              <BrowserRow
                key=".."
                label=".."
                icon="level-up"
                target={parent}
                navigable
                className="pane-browser-parent"
                onOpen={onOpen}
                onBrowse={onBrowse}
              />
            ) : null}

            {sorted.map((entry) => (
              <BrowserRow
                key={entry.name}
                label={entry.name}
                icon={isNavigable(entry) ? 'folder' : 'file'}
                target={joinPath(path ?? '', entry.name, pathKind)}
                navigable={isNavigable(entry)}
                link={entry.kind === 'symlink'}
                onOpen={onOpen}
                onBrowse={onBrowse}
              />
            ))}

            {state.phase === 'ready' && !sorted.length ? (
              <p className="pane-browser-note">Nothing here.</p>
            ) : null}
            {state.phase === 'loading' ? <p className="pane-browser-note">Listing…</p> : null}
          </>
        )}
      </div>

      <div className="pane-browser-foot">
        <small>Double-click a folder to take the shell there.</small>
        {/* The same action as a double-click, on the directory already open.
            Worth having as a button: a double-click can be refused because the
            pane was busy at that moment, and this is how it is retried without
            navigating away and back. */}
        <button
          type="button"
          className="pane-browser-send"
          disabled={!path}
          onClick={() => path && onOpen(path)}
          title="Take the shell to this directory"
          aria-label="Take the shell to this directory"
        >
          <Icon name="send-right" />
        </button>
      </div>
    </div>
  );
}

function BrowserRow({
  label,
  icon,
  target,
  navigable,
  link,
  className = '',
  onOpen,
  onBrowse
}: {
  label: string;
  icon: string;
  target: string;
  navigable: boolean;
  link?: boolean;
  className?: string;
  onOpen: (path: string) => void;
  onBrowse: (path: string) => void;
}) {
  // The single click is held back until a double-click could no longer arrive.
  // Acting on it at once broke the gesture rather than pre-empting it: browsing
  // replaces the list, so the second press landed on a different row and the
  // dblclick never reached this one. Reported as "double-click does the same as
  // single click", which is exactly what it looked like.
  const activation = useRowActivation(
    () => navigable && onBrowse(target),
    () => navigable && onOpen(target)
  );
  return (
    <button
      type="button"
      className={`pane-browser-row ${navigable ? '' : 'pane-browser-file'} ${className}`.trim()}
      disabled={!navigable}
      onClick={activation.onClick}
      onDoubleClick={activation.onDoubleClick}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || !navigable) return;
        // Enter is unambiguous, so it goes straight to taking the shell there.
        event.preventDefault();
        activation.cancel();
        onOpen(target);
      }}
      title={navigable ? `${label} — double-click to take the shell there` : label}
    >
      <Icon name={icon} />
      <span className="pane-browser-name">{label}</span>
      {link ? <span className="pane-browser-kind">link</span> : null}
    </button>
  );
}
