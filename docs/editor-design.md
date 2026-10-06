# Built-in text editor: design note (task 5, phase 0)

Status: **proposal, nothing built.** Decisions the user needs to make are at the end.

## Goal

Open, edit and save a text file from inside ZeroG (a suggested `.env` change, a config to read) without leaving Claude Code. It opens over the panes so the terminal behind stays loaded, starts in the pane's current directory, and can later sit beside a terminal as its own pane.

## What exists and what is missing

- **Navigating:** `pane-browser.tsx` lists directories for local, WSL and SSH panes through `PaneListingApi`, and gets the pane's directory from `cwd-tracker`. File rows are rendered disabled. Opening one needs an `onOpenFile` prop and enabled file rows.
- **Local files:** `local-fs.ts` lists, makes directories, renames and removes. It deliberately never reads contents, so it needs `readLocalFile` and `writeLocalFile` plus IPC (`main.ts`, `preload.cjs`, `TerminalApi` in `types.ts`). Paths go through `resolveLocalPath` (absolute, no NUL, 4096 max). WSL panes are listed as `\\wsl.localhost\<distro>\…` paths through the same local functions, so WSL files work with no extra code.
- **Remote files:** `sftp-service.ts` drives the system `sftp` binary on a pty, one reused connection per target. It has `download(remotePath, localDir)` and `upload(localPath, remoteDir)`, but no read or write. Both take a directory and keep the base name.
- **Dependencies:** no editor library and no `ssh2`.
- **Panes:** a pane is a terminal session. `reconcileWorkspaces` deletes any id not in the live session list, the store rejects members that are not `local` or `ssh`, and session restore only knows terminals. There is no non-terminal pane type. The directory browser is a sidecar inside a terminal pane, not a pane.
- **Overlays:** modals use `modal-layer` and `useBackdropDismiss`. Escape is one window handler using `DISMISS_ORDER` in `shortcuts.ts`, which fires even from a text field.

## Proposal

### Widget: a plain `<textarea>` first
Monospace, Tab inserts a tab, Ctrl+S saves, a dirty marker, and line and column in a footer. It needs no dependency and suits the stated use (small config files). CodeMirror 6 can replace it later behind the same `editor-state` module if syntax colouring or large files matter. This is the cheapest thing that answers the need and can be swapped.

### Local read and write
- `readLocalFile(path)` returns `{ text, size, mtimeMs }`. It refuses files over a size cap, refuses a file containing a NUL byte as binary, and reads as UTF-8 (a file that does not decode cleanly is refused rather than corrupted on save).
- `writeLocalFile(path, text, expectedMtimeMs)` refuses when the file's mtime differs from what was loaded, so a file changed on disk is flagged before it is overwritten. It writes **in place** rather than temp-and-rename, so symlinks, permissions and ownership survive. That matters for `.env` files. The trade-off is that an interrupted write can truncate, which is acceptable for small text files.
- Neither logs contents, and file contents never reach command history or the redaction path.

### Remote read and write (a later slice)
- **Read:** `sftpOpen`, then `download` to a private temp directory, then a local read, then delete the temp file.
- **Save:** write the temp file under the same base name, `upload` to the remote directory, delete the temp file.
- **Conflict check:** `sftp ls` times are minute-resolution, so compare content instead. Before uploading, download again and compare it with the text first loaded. This costs a second round trip but is exact.
- **Prompts:** passwords and host-key prompts only have a UI in the transfer panel. Start by working only once the connection is already authenticated (the pane browser already behaves this way), and say so when it is not. Rendering its own prompt answerer is a follow-up.
- **Limits:** `isSafeRemotePath` refuses names with quotes, backslashes, wildcards or control characters, so such files cannot be edited remotely, and the editor should say why. Each `sftp` call is slow, so show a busy state and never block the UI.
- An `ssh2` stream would be faster, but it is a new dependency and a second auth path. Measure real latency on a real host before deciding.

### Overlay first, pane later
1. **Slice 1, local files, modal overlay.** Add `readLocalFile` and `writeLocalFile`, an `editor-state.ts` (dirty tracking, conflict handling, size and binary rules, fully unit tested), an `editor-overlay.tsx`, an `onOpenFile` mode on the browser, an entry in `DISMISS_ORDER` and a guard that asks before closing with unsaved changes. A button on each pane opens it in that pane's directory. Closing returns focus to the terminal.
2. **Slice 2, SSH files** as above.
3. **Slice 3, dock as a pane.** This is the largest piece because nothing in the pane model supports a non-terminal pane. It needs an id namespace that `reconcileWorkspaces` leaves alone, a new stored member kind, session-restore handling, grid placeholders, and a decision on pane-link and MCP (which should simply not see it). I would prototype it on its own after slice 1 proves the editor, and consider a lighter option: dock the editor as a sidecar beside the terminal it was opened from, the way the directory browser is, instead of a full pane.

## Decisions for the user

1. **Widget:** plain textarea first, CodeMirror later if needed. (Recommended: textarea.)
2. **Size cap:** suggest 1 MiB, with a clear message above it.
3. **First slice:** local files only, with SSH as slice 2. (Recommended.)
4. **Write mode:** in place, to keep symlinks and permissions. (Recommended.)
5. **Dock:** a full pane or a sidecar. Decide after slice 1, not now.

## Risks

- The remote path is slow and prompt-dependent. Treat it as a separate slice.
- A pane that is not a terminal touches the persistence and reconcile code that tasks 1 to 4 also rely on. Keep it last.
- Editing a file the terminal is also changing (an agent writing it) can lose changes. The mtime and content check is the protection, and it must not be skipped.
