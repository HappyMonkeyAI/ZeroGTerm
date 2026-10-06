// The built-in text editor, opened over the panes.
//
// An overlay rather than a pane, so the terminal behind it is untouched: still
// running, still holding its scrollback, and focused again the moment this
// closes. Files are chosen with the same directory browser the panes use, and
// read and written one at a time through the main process — see local-fs.ts for
// the limits it enforces and why.
//
// Nothing here closes without asking if there is unsaved text, because the
// usual reason to be in this editor is a file the user is about to depend on.

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EDIT_CONFLICT_MESSAGE } from '../shared/editing';
import { baseName } from '../shared/files';
import type { DirectoryListing, LocalFileContent, LocalFileStamp } from '../shared/types';
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
import type { SessionInfo } from '../shared/types';

export type EditorApi = {
  readLocalFile(path: string): Promise<LocalFileContent>;
  writeLocalFile(path: string, text: string, expectedMtimeMs: number, overwrite?: boolean): Promise<LocalFileStamp>;
};

type Loaded = {
  path: string;
  /** What the textarea started from, and what "unchanged" means. */
  saved: string;
  ending: LineEnding;
  /** When the file was last changed on disk, as far as this editor knows. */
  mtimeMs: number;
};

export type EditorOverlayProps = {
  session: SessionInfo;
  /** Where the browser starts: the pane's directory. */
  startPath: string | null;
  pathKind: PathKind;
  shellPathFor: (path: string) => string;
  list: (path?: string) => Promise<DirectoryListing>;
  api: EditorApi;
  /** Shut the editor. Only called once there is nothing unsaved, or the user said to discard it. */
  onClose: () => void;
  /** Filled with this editor's own close request, so Escape from outside can ask the same question. */
  closeRef: React.MutableRefObject<(() => void) | null>;
};

export function EditorOverlay({ session, startPath, pathKind, shellPathFor, list, api, onClose, closeRef }: EditorOverlayProps) {
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

  const requestClose = useCallback(() => {
    if (discardOk('Close the editor and lose them?')) onClose();
  }, [discardOk, onClose]);

  // Always the latest, so the window's Escape handler never asks with a stale
  // idea of whether there is anything unsaved.
  useEffect(() => {
    closeRef.current = requestClose;
    return () => {
      closeRef.current = null;
    };
  }, [closeRef, requestClose]);

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
      api
        .readLocalFile(path)
        .then((file) => {
          const editable = toEditorText(file.text);
          setLoaded({ path: file.path, saved: editable, ending: detectLineEnding(file.text), mtimeMs: file.mtimeMs });
          setText(editable);
          setCaret(0);
          requestAnimationFrame(() => area.current?.focus());
        })
        .catch((error: unknown) => setMessage(ipcMessage(error)))
        .finally(() => setBusy(null));
    },
    [api, discardOk, loaded?.path]
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
      api
        .writeLocalFile(loaded.path, fromEditorText(text, loaded.ending), loaded.mtimeMs, overwrite)
        .then((stamp) => {
          setLoaded({ ...loaded, saved: text, mtimeMs: stamp.mtimeMs });
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
    [api, busy, loaded, text]
  );

  /** Throw away the edits and read the file again — the other answer to a conflict. */
  const reload = () => {
    if (!loaded) return;
    if (!window.confirm(`Discard your changes to ${baseName(loaded.path)} and load what is on disk?`)) return;
    setBusy('opening');
    api
      .readLocalFile(loaded.path)
      .then((file) => {
        const editable = toEditorText(file.text);
        setLoaded({ path: file.path, saved: editable, ending: detectLineEnding(file.text), mtimeMs: file.mtimeMs });
        setText(editable);
        setConflict(false);
        setMessage(null);
      })
      .catch((error: unknown) => setMessage(ipcMessage(error)))
      .finally(() => setBusy(null));
  };

  const position = cursorPosition(text, caret);
  const name = loaded ? baseName(loaded.path) : null;

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
              {dirty ? <span className="editor-dirty" title="Unsaved changes" aria-label="Unsaved changes"> ●</span> : null}
            </h2>
          </div>
          <div className="editor-actions">
            <button type="button" className="primary-button" disabled={!loaded || !dirty || busy !== null} onClick={() => save()}>
              {busy === 'saving' ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="close-button" onClick={requestClose} title="Close the editor">Esc</button>
          </div>
        </header>

        <div className="editor-body">
          <div className="editor-files">
            <PaneBrowser
              session={session}
              path={browsePath}
              pathKind={pathKind}
              shellPath={browsePath ? shellPathFor(browsePath) : null}
              list={list}
              onOpen={setBrowsePath}
              onBrowse={setBrowsePath}
              onClose={requestClose}
              onOpenFile={openFile}
              openFile={loaded?.path ?? null}
            />
          </div>

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
                <p>{busy === 'opening' ? 'Opening…' : 'Pick a file on the left to edit it. The terminal behind keeps running.'}</p>
              </div>
            )}
          </div>
        </div>

        <footer className="editor-foot">
          <span className="editor-status" role="status">{message ?? (loaded ? loaded.path : '')}</span>
          {loaded ? (
            <span className="editor-position">
              Ln {position.line}, Col {position.column} · {loaded.ending === 'crlf' ? 'CRLF' : 'LF'} · UTF-8
            </span>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
