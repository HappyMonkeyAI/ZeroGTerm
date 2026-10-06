# Feature dev tasks

Ideas from day-to-day use, written as bounded task packets (format adapted from the luna_framework `TASK-TEMPLATE.md`). Tasks are numbered in suggested build order. Each packet is meant to be picked up on its own.

## Conventions for every packet

- **Stack:** Electron main process (`src/main`, `tsc`), React renderer (`src/renderer`, Vite), xterm.js, node-pty, vitest. `src/renderer/main.tsx` is a ~4.9k-line single file; line numbers below are approximate and were taken at commit `9a9648e` on `feat/pane-link`. Re-find them by symbol name.
- **Standard verification (all tasks):**
  - `npm run typecheck`
  - `npm test`
  - `git diff --check`
  - A manual check in the running app where the packet says so. Typecheck and tests cannot prove a UI behaviour, so say plainly when that step was not run.
- **Pure logic goes in its own module with a test** (the pattern used by `pane-layout.ts`, `menu-position.ts`, `session-dialog.ts`), so the behaviour is covered without driving the UI.
- **Forbidden scope (all tasks):** no commit, merge, push, reset, stash or clean without being asked; no dependency changes unless the packet lists them; no edits outside the owned paths; no reading or storing secrets.
- **Escalate** after two failed repair attempts, or sooner if the work reveals an unplanned public boundary (IPC shape, stored-file format) or a contract the packet did not anticipate.
- **Starting state:** the working tree has uncommitted changes from task 1 (`context-menu.tsx`) and this file. Preserve them.

---

## Task 1 — Fix workspace rename (right-click)

- **Status:** Committed (`5ef839e`), typecheck passes. **Not yet confirmed in the running app.**
- **Objective:** Choosing "Rename…" from a workspace tab's right-click menu opens the rename modal, and submitting it renames the workspace.
- **Cause found:** `context-menu.tsx` registered a window-level capture `pointerdown` listener that closed the menu on any press. It runs before React's handlers, so the item was unmounted before its click arrived and no menu command ever ran. This affected Duplicate, Move left/right and Close workspace too.
- **Change made:** the listener (`dismissOutside`) ignores presses inside the menu card. The `stopPropagation` call on the card was removed because it never worked.
- **Owned paths:** `src/renderer/context-menu.tsx`; a new test only if one can be written without a DOM (see below).
- **Acceptance criteria:**
  1. Right-click a workspace tab, choose Rename…: the modal opens with the current name filled in.
  2. Submitting a new valid name updates the tab and shows a status line.
  3. Duplicate, Move left, Move right and Close workspace also run from the menu.
  4. A press outside the menu, Escape, window blur and scroll still close it.
- **Open question:** `commitWorkspaceRename` (`main.tsx`) returns silently when the name fails `WORKSPACE_NAME_PATTERN` (starts with a symbol, or over 49 characters). The input's `pattern` attribute normally blocks submit, but confirm the user sees a reason. If not, show a status message instead of closing silently.
- **Verification:** standard, plus criteria 1–4 by hand. There is no test file for the menu, and the repo has no DOM test setup, so do not add a fragile one.
- **Remaining:** confirm in the app, then commit.

---

## Task 2 — Remember session labels per host

- **Objective:** In the SSH dialog, entering a host that has been connected to before prefills "Session label" with the last label used for it. A successful connect saves the label against that host.
- **Why:** the label (`sshName`) is retyped every time ("dev server", "web server").
- **Owned paths:**
  - new `src/main/host-label-store.ts` (JSON file in userData, atomic temp-file-then-rename write, same shape as `port-forward-store.ts`)
  - new `tests/host-label-store.test.ts`
  - IPC wiring in `src/main/main.ts` and `src/main/preload.cjs`
  - the SSH dialog and `sshName` handling in `src/renderer/main.tsx`
  - types in `src/shared/types.ts` if the IPC shape needs one
- **Required reading:** `src/main/port-forward-store.ts` and its test (the pattern to copy); `src/main/ssh-inventory.ts` (how host targets are parsed); the SSH dialog block in `main.tsx` (~4581) and `createSsh` (~2077).
- **Design decisions to settle first:**
  - **Key:** normalise the target before using it as a key (host only, or user@host:port?). Two users on one host may want different labels. Recommend `user@host:port` as typed, lowercased host, so a lookup matches what the dialog submits. Decide and record it.
  - **When to prefill:** only if the label field is still empty or untouched, so a label the user is typing is never overwritten.
  - **Failure:** a missing or corrupt file means no remembered labels, never a crash or a blocked connect.
- **Acceptance criteria:**
  1. Connect to a host with label "dev server", close the dialog, reopen it and type the same host: the label field shows "dev server".
  2. Connecting again with a different label stores the new one.
  3. A blank label does not erase a stored one.
  4. A corrupt or missing store file is tolerated.
  5. No secrets or passwords are written to this file.
- **Verification:** standard. Unit tests for key normalisation, set/get, blank label and corrupt file. Manual check of the dialog.
- **Stop and report if:** the SSH target is not available as a stable string at dialog time, or labels are already stored elsewhere (check `session-history.json` before adding a new file).

---

## Task 3 — Custom configurable pane buttons (0–9)

- **Objective:** Replace the two hardcoded pane-bar buttons with up to ten configurable ones. Each has a label and a text/command that is typed into the pane's pty, followed by Enter. A button appears on the pane top bar only when it is configured. They are numbered square icon buttons, right-aligned like the existing ones.
- **Owned paths:**
  - `src/renderer/settings.ts` (type, defaults, sanitising on load)
  - `src/renderer/settings-panel.tsx` (editor UI)
  - `src/renderer/main.tsx` (pane bar buttons ~4103–4119, handlers `sendProceed` ~3296 and `sendAiCommand` ~3313)
  - `tests/settings.test.ts` (extend)
  - CSS for the buttons, wherever `.pane-proceed` and `.pane-ai` are styled
- **Required reading:** `AiSettings` (~100), `resolveProceedPhrase` (~338), `resolveAiCommand` (~342) and the load sanitiser (~419) in `settings.ts`; the proceed phrase and AI command fields in `settings-panel.tsx` (~998–1012); the two handlers in `main.tsx`.
- **Design decisions to settle first:**
  - **Existing buttons:** keep "OK Proceed" and "Run Claude" as they are and add the ten as a separate group, or fold them in as defaults for slots 0 and 1. Folding in is cleaner. It needs a migration so existing `proceedPhrase` and `aiCommand` values carry over, and it must not lose them.
  - **Slot data:** `{ label, command }` per slot, empty command means hidden. Cap the length of both and sanitise on load, as the existing settings do.
  - **Sending:** reuse the existing write path (`api().write`, phrase plus `\r`). Check the pane-link logic (`pane-link.ts`) so a button press interacts sensibly with a linked pane.
  - **Display:** show the slot number, with the label as the tooltip and accessible name.
- **Acceptance criteria:**
  1. Settings has ten editable slots (label and command).
  2. A slot with no command shows no button; a configured slot shows a numbered button on every pane's top bar.
  3. Pressing it sends the command and Enter to that pane only.
  4. Existing users keep their current proceed phrase and AI command.
  5. Malformed stored settings fall back to defaults without throwing.
- **Verification:** standard. Extend `settings.test.ts` for sanitising, the migration and empty slots. Manual check that a button sends text to a shell pane.
- **Stop and report if:** the settings storage version needs bumping, or pane-link relays a button's text in a way that loops.

---

## Task 4 — Choose which panes show in a 2-way split

- **Objective:** When a workspace has more than two panes and the layout is a 2-way split, each pane shows left/right arrows so the user can choose which two panes are visible, and the choice persists with the workspace.
- **Problem today:** pane count is `layout==='stack' ? 1 : layout==='grid' ? 4 : 2` (`main.tsx` ~1810) and `isPaneVisible` is `index < paneCount` (~1854), so a 2-way split can only ever show the first two.
- **Owned paths:**
  - `src/renderer/pane-layout.ts` (pure logic) and `tests/pane-layout.test.ts`
  - `src/shared/types.ts` (`StoredWorkspaceView`, ~172), if the visible set is stored per workspace
  - `src/renderer/workspace-view.ts` (per-workspace view state helpers)
  - `src/renderer/main.tsx` (`paneCount`, `renderedPaneCount`, `isPaneVisible`, the hidden-pane handling ~1879, pane bar arrows, grid CSS ~2982–3003)
- **Required reading:** all of `pane-layout.ts` and its test; `StoredWorkspaceView` and the code that saves and restores it; how a pane's `index` is used for focus order and shortcuts.
- **Design decisions to settle first:**
  - **Model:** store an ordered list of visible pane ids (or indices) instead of deriving visibility from `index < paneCount`. For stack and grid layouts the list can still be derived.
  - **Arrow meaning:** "move this pane's slot to the previous/next pane" (swap the shown pane with its neighbour among the hidden ones). Define what the arrows do at the ends, and with only two panes in total (arrows hidden).
  - **Hidden panes keep running.** Their ptys must stay alive and keep receiving output. Check what the existing hidden-pane handling does and keep it.
  - **Restore:** a stored list that refers to a closed pane must fall back to a valid selection.
- **Acceptance criteria:**
  1. With 3 or 4 panes in a 2-way split, each visible pane shows left/right arrows; with 2 or fewer it does not.
  2. Using an arrow swaps in the next or previous pane without killing any session.
  3. The choice survives switching workspaces and restarting the app.
  4. Closing a pane or changing layout never leaves an invalid visible set.
  5. Focus and keyboard shortcuts still target the visible pane.
- **Verification:** standard. Heavy unit coverage in `pane-layout.test.ts` for the pure selection logic (next, previous, ends, closed pane, layout switch). Manual check with four panes.
- **Stop and report if:** pane identity is positional in a way that makes reordering unsafe (focus, session mapping, pane-link ids). Pane link depends on pane identity, so check `pane-link.ts` first.

---

## Task 5 — Built-in text editor (design, then build)

- **Objective:** Open, edit and save a text file without leaving ZeroGTerm. It starts as a modal overlay above the panes, so the pane behind (e.g. Claude Code) stays loaded. A button converts it into a real pane when a pane slot is free, so it can sit beside the terminal in a 2-way split. Files are chosen with a navigator based on the existing directory browser, starting in the pane's current directory.
- **Phase 0 (do first, produces a decision, not code):** a short design note and throwaway prototype covering the editor widget and remote file access. This is the largest and least certain item; do not start the build before the choices below are made.
- **Design decisions to settle in phase 0:**
  - **Editor widget:** plain `<textarea>` (simple, no dependency, weak on large files and no syntax colouring) versus CodeMirror 6 (a new dependency). Start with the textarea for `.env`-style edits and decide whether that is enough.
  - **Remote reads/writes:** today only `list`, `mkdir`, `rename`, `remove`, `upload` and `download` exist, via the system `sftp` binary under node-pty (`sftp-service.ts`), which is slow per call. Options: reuse download/upload through a temp file, or add an `ssh2` SFTP stream (new dependency). Measure before choosing.
  - **Local reads/writes:** `local-fs.ts` has no read or write; add `readLocal` and `writeLocal` with size limits.
  - **Safety:** refuse or warn on binary files and files over a size cap (decide the cap); detect that a file changed on disk since it was loaded before overwriting; never log file contents; keep file contents out of command history and the redaction path.
  - **Overlay to pane:** the editor becomes a pane type. Check how panes are modelled (`SessionInfo`, `StoredWorkspaceView`) and what a non-terminal pane implies for session restore and pane link.
  - **Which host:** the editor works on the host of the pane it was opened from (local, WSL or SSH), using the pane's tracked current directory (`cwd-tracker`).
- **Owned paths (provisional, confirm in phase 0):**
  - new `src/renderer/editor-pane.tsx` and `src/renderer/editor-state.ts` (pure logic: dirty tracking, conflict detection)
  - new `tests/editor-state.test.ts`
  - `src/main/local-fs.ts` and `tests/local-fs.test.ts` (read/write)
  - `src/main/sftp-service.ts` and `src/main/sftp-protocol.ts` (remote read/write), with their tests
  - `src/main/main.ts`, `src/main/preload.cjs`, `src/shared/types.ts` (IPC)
  - `src/renderer/pane-browser.tsx` (reuse or extract a file picker mode)
  - `src/renderer/main.tsx` (open from a pane, modal, convert to pane)
  - `src/renderer/pane-layout.ts` if a non-terminal pane changes layout rules
- **Required reading:** `pane-browser.tsx`, `pane-directory.ts`, `pane-listing.ts`, `src/shared/files.ts`, `local-fs.ts`, `sftp-service.ts`, `sftp-protocol.ts`, and the existing `sftp-panel.tsx` for how remote files are handled today.
- **Acceptance criteria (for the first buildable slice, local files only):**
  1. A button on a pane opens the editor in the pane's current directory; the pane behind keeps running.
  2. Choose a file in the navigator, edit it, save it, and the change is on disk.
  3. A dirty file prompts before closing or switching file.
  4. A file changed on disk since loading is flagged before it is overwritten.
  5. Binary or oversized files are refused with a message.
  6. Closing the editor returns focus to the terminal pane.
  - Later slices, each its own packet: remote (SSH) files; convert to a pane beside a terminal; unsaved-changes restore.
- **Verification:** standard. Unit tests for editor state, local read/write limits and conflict detection. Manual check of save, close and conflict. For remote, test against a real host and record the latency.
- **Stop and report if:** the pane model cannot take a non-terminal pane without a wider refactor of `main.tsx`; or remote read/write via `sftp` is too slow or fragile to be usable and an `ssh2` dependency is needed.

---

## Evidence handoff (fill in per task when it is worked)

| Task | Worker status | Owner status | Changed paths | Typecheck / tests | Manual check | Notes |
|---|---|---|---|---|---|---|
| 1 | Ready for review | Not reviewed | `src/renderer/context-menu.tsx` | typecheck passes; tests not run | not run | committed `5ef839e`; confirm in app |
| 2 | Ready for review | Not reviewed | `src/main/host-label-store.ts`, `src/renderer/host-labels.ts`, `src/renderer/main.tsx`, IPC/types, `tests/host-label-store.test.ts` | typecheck passes; 55 files / 1046 tests pass | not run | committed `4bc6330`; key is the bare lowercased host, saved only from the SSH dialog |
| 3 | Ready for review | Not reviewed | `src/renderer/settings.ts`, `settings-panel.tsx`, `main.tsx`, `styles.css`, new `pane-buttons.ts`, `tests/settings.test.ts`, `tests/pane-buttons.test.ts` | typecheck passes; 56 files / 1059 tests pass | not run | committed; existing proceed/AI buttons kept separate (AI command is also the linked-agent launcher) |
| 4 | Ready for review | Not reviewed | new `src/renderer/pane-selection.ts`, `workspace-view.ts`, `workspace-store.ts`, `main.tsx`, `src/shared/types.ts`, tests | typecheck passes; 57 files / 1082 tests pass | not run | committed; selecting a hidden pane in the sidebar still widens to the grid (unchanged) |
| 5 | Slices 1 (local), 2 (SSH) and 3 (dock) ready for review | Not reviewed | `src/main/local-fs.ts`, `src/renderer/editor-overlay.tsx`, `editor-state.ts`, `pane-browser.tsx`, `src/shared/editing.ts`, IPC/types, `tests/local-file.test.ts`, `tests/editor-state.test.ts` | typecheck, build and 59 files / 1113 tests pass | not run | committed; design in `docs/editor-design.md`. SSH read/save added in slice 2 (new `remote-file.ts`, `editor-backend.ts`). Known limits: a password/host-key prompt can only be answered in the transfer panel; unusual file names are refused. Slice 3 docks the editor as a sidecar in the terminal's own pane (not a separate pane slot); not persisted across restarts, one editor per pane. A true separate pane remains unbuilt. |
