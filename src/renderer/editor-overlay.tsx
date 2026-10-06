// The built-in text editor: opened over the panes, or docked beside a terminal.
//
// Not a pane, so the terminal it was opened from is untouched: still running,
// still holding its scrollback, and focused again the moment this closes. Docked,
// it takes the right-hand side of that terminal's own pane — the space the
// directory browser uses — rather than a pane slot of its own, which would have
// meant teaching every part of the workspace about panes that are not terminals.
// Files are chosen with the same directory browser the panes use, and read and
// written one at a time — see local-fs.ts and remote-file.ts for the limits.
//
// Nothing here closes without asking if there is unsaved text, because the
// usual reason to be in this editor is a file the user is about to depend on.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EDIT_CONFLICT_MESSAGE } from '../shared/editing';
import { baseName } from '../shared/files';
import type { DirectoryListing, SessionInfo } from '../shared/types';
import type { EditorBackend, FileVersion } from './editor-backend';
import {
  cursorPosition,
  detectLineEnding,
  exceedsSaveLimit,
  fromEditorText,
  insertTab,
  isDirty,
  toEditorText,
  type LineEnding
} from './editor-state';
import { ipcMessage } from './ipc-message';
import { Icon } from './icons';
import { PaneBrowser } from './pane-browser';
import type { PathKind } from './pane-directory';


type Loaded = {
  path: string;
  /** What the textarea started from, and what "unchanged" means. */
  saved: string;
  ending: LineEnding;
  /** When the file was last changed on disk, as far as this editor knows. */
  version: FileVersion;
};

export type EditorMode = 'overlay' | 'docked';

/**
 * Asks to close the editor. Resolves to whether it did: false when there was
 * unsaved text and the user chose to keep it.
 */
export type EditorCloser = () => boolean;

export type EditorHostProps = {
  session: SessionInfo;
  mode: EditorMode;
  /** The pane's slot to render into when docked. Null until the pane has made one. */
  dock: HTMLElement | null;
  onModeChange: (mode: EditorMode) => void;
  /** Where the browser starts: the pane's directory. */
  startPath: string | null;
  pathKind: PathKind;
  shellPathFor: (path: string) => string;
  list: (path?: string) => Promise<DirectoryListing>;
  backend: EditorBackend;
  /** An SSH pane can list before its shell has said anything; the connection knows where it is. */
  unanchored?: boolean;
  /** What the host is waiting to be asked, shown by the browser; answered in the transfer panel. */
  question?: string | null;
  /** Shut the editor. Only called once there is nothing unsaved, or the user said to discard it. */
  onClose: () => void;
  /** Told this editor's own close request, so Escape and closing the pane can ask the same question. */
  register: (closer: EditorCloser | null) => void;
};

export function EditorHost({
  session,
  mode,
  dock,
  onModeChange,
  startPath,
  pathKind,
  shellPathFor,
  list,
  backend,
  unanchored,
  question,
  onClose,
  register
}: EditorHostProps) {
  // Docked, the file list is out of the way once a file is open: the pane is half
  // a window wide, and the text is what the user came for.
  const [filesOpen, setFilesOpen] = useState(true);
  const [browsePath, setBrowsePath] = useState<string | null>(startPath);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState<'opening' | 'saving' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const dirty = loaded ? isDirty(loaded.saved, text) : false;

  const discardOk = useCallback(
    (what: string) => !dirty || window.confirm(`You have unsaved changes to ${baseName(loaded?.path ?? '')}. ${what}`),
    [dirty, loaded]
  );

  const requestClose = useCallback((): boolean => {
    if (!discardOk('Close the editor and lose them?')) return false;
    onClose();
    return true;
  }, [discardOk, onClose]);

  // Always the latest, so whoever asks never does so with a stale idea of
  // whether there is anything unsaved.
  useEffect(() => {
    register(requestClose);
    return () => register(null);
  }, [register, requestClose]);

  // A Tab typed into the box moves the caret after React has put the new text
  // in, or it would land at the end.
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !area.current) return;
    area.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [text]);

  const openFile = useCallback(
    (path: string) => {
      if (path === loaded?.path) return;
      if (!discardOk('Open another file and lose them?')) return;
      setBusy('opening');
      setMessage(null);
      setConflict(false);
      backend
        .read(path)
        .then((file) => {
          const editable = toEditorText(file.text);
          setLoaded({ path: file.path, saved: editable, ending: detectLineEnding(file.text), version: file.version });
          setText(editable);
          setCaret(0);
          if (mode === 'docked') setFilesOpen(false);
          requestAnimationFrame(() => area.current?.focus());
        })
        .catch((error: unknown) => setMessage(ipcMessage(error)))
        .finally(() => setBusy(null));
    },
    [backend, discardOk, loaded?.path, mode]
  );

  const save = useCallback(
    (overwrite = false) => {
      if (!loaded || busy) return;
      if (exceedsSaveLimit(text)) {
        setMessage('That is too large for the editor to save.');
        return;
      }
      setBusy('saving');
      setMessage(null);
      backend
        .write(loaded.path, fromEditorText(text, loaded.ending), loaded.version, overwrite)
        .then((version) => {
          setLoaded({ ...loaded, saved: text, version });
          setConflict(false);
          setMessage(`Saved ${baseName(loaded.path)}`);
        })
        .catch((error: unknown) => {
          const reason = ipcMessage(error);
          if (reason.includes(EDIT_CONFLICT_MESSAGE)) setConflict(true);
          else setMessage(reason);
        })
        .finally(() => setBusy(null));
    },
    [backend, busy, loaded, text]
  );

  /** Throw away the edits and read the file again — the other answer to a conflict. */
  const reload = () => {
    if (!loaded) return;
    if (!window.confirm(`Discard your changes to ${baseName(loaded.path)} and load what is on disk?`)) return;
    setBusy('opening');
    backend
      .read(loaded.path)
      .then((file) => {
        const editable = toEditorText(file.text);
        setLoaded({ path: file.path, saved: editable, ending: detectLineEnding(file.text), version: file.version });
        setText(editable);
        setConflict(false);
        setMessage(null);
      })
      .catch((error: unknown) => setMessage(ipcMessage(error)))
      .finally(() => setBusy(null));
  };

  const position = cursorPosition(text, caret);
  const name = loaded ? baseName(loaded.path) : null;
  const docked = mode === 'docked';

  const saveButton = (
    <button type="button" className="primary-button" disabled={!loaded || !dirty || busy !== null} onClick={() => save()}>
      {busy === 'saving' ? 'Saving…' : 'Save'}
    </button>
  );
  const dirtyMark = dirty ? <span className="editor-dirty" title="Unsaved changes" aria-label="Unsaved changes"> ●</span> : null;

  const files = (
    <PaneBrowser
      session={session}
      path={browsePath}
      unanchored={unanchored}
      question={question}
      pathKind={pathKind}
      shellPath={browsePath ? shellPathFor(browsePath) : null}
      list={list}
      onOpen={setBrowsePath}
      onBrowse={setBrowsePath}
      // Docked, closing the list just gives the text the room; the editor stays.
      onClose={docked ? () => setFilesOpen(false) : requestClose}
      onOpenFile={openFile}
      openFile={loaded?.path ?? null}
    />
  );

  const main = (
    <div className="editor-main">
      {conflict ? (
        <div className="editor-banner" role="alert">
          <span>{EDIT_CONFLICT_MESSAGE} Saving now would replace those changes.</span>
          <button type="button" onClick={() => save(true)}>Overwrite</button>
          <button type="button" onClick={reload}>Reload from disk</button>
          <button type="button" onClick={() => setConflict(false)}>Keep editing</button>
        </div>
      ) : null}

      {loaded ? (
        <textarea
          ref={area}
          className="editor-text"
          value={text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          aria-label={`Contents of ${name}`}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setMessage(null);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              if (dirty) save();
              return;
            }
            if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
              event.preventDefault();
              const target = event.currentTarget;
              const next = insertTab(text, target.selectionStart, target.selectionEnd);
              pendingCaret.current = next.caret;
              setText(next.text);
              setCaret(next.caret);
            }
          }}
        />
      ) : (
        <div className="editor-empty">
          <Icon name="file" />
          <p>{busy === 'opening' ? 'Opening…' : 'Pick a file to edit it. The terminal keeps running.'}</p>
        </div>
      )}
    </div>
  );

  const foot = (
    <footer className="editor-foot">
      <span className="editor-status" role="status">{message ?? (loaded ? loaded.path : '')}</span>
      {loaded ? (
        <span className="editor-position">
          Ln {position.line}, Col {position.column} · {loaded.ending === 'crlf' ? 'CRLF' : 'LF'} · UTF-8
        </span>
      ) : null}
    </footer>
  );

  // Docked, the editor lives in the pane it was opened from, beside the
  // terminal. Rendered into that pane's slot as a portal so this component —
  // and the file it holds — stays mounted when it moves between the two.
  if (docked) {
    if (!dock) return null;
    return createPortal(
      <section className="editor-docked" aria-label={`Editor for ${session.name}`}>
        <header className="editor-dock-head">
          <span className="editor-dock-name" title={loaded?.path ?? ''}>
            {name ?? 'Editor'}
            {dirtyMark}
          </span>
          <span className="editor-dock-actions">
            {saveButton}
            <button type="button" className="pane-nav" onClick={() => setFilesOpen((open) => !open)} aria-pressed={filesOpen} title="Show or hide the file list">
              <Icon name="folder" />
            </button>
            <button type="button" className="pane-nav" onClick={() => onModeChange('overlay')} title="Pop out over the panes">
              <Icon name="maximize" />
            </button>
            <button type="button" className="pane-nav" onClick={() => requestClose()} title="Close the editor" aria-label="Close the editor">
              <Icon name="x" />
            </button>
          </span>
        </header>
        {filesOpen || !loaded ? <div className="editor-files editor-files-docked">{files}</div> : null}
        {main}
        {foot}
      </section>,
      dock
    );
  }

  return (
    <div
      className="modal-layer editor-layer"
      role="presentation"
      // Escape from anywhere inside, here, so it asks about unsaved text and
      // never reaches the window handler or the terminal underneath.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
    >
      <section className="editor-card" role="dialog" aria-modal="true" aria-label={`Edit files from ${session.name}`}>
        <header className="editor-head">
          <div className="editor-title">
            <span className="eyebrow">Editor · {session.name}</span>
            <h2>
              {name ?? 'Choose a file'}
              {dirtyMark}
            </h2>
          </div>
          <div className="editor-actions">
            {saveButton}
            <button type="button" onClick={() => onModeChange('docked')} title="Keep the editor beside this terminal instead of over it">
              Dock
            </button>
            <button type="button" className="close-button" onClick={() => requestClose()} title="Close the editor">Esc</button>
          </div>
        </header>

        <div className="editor-body">
          <div className="editor-files">{files}</div>
          {main}
        </div>

        {foot}
      </section>
    </div>
  );
}
