# Feature Development Tasks

## MCP interactive command control

The implementation is complete for the selected interactive-pane execution model. The following tasks remain as follow-up work or acceptance activities.

### 1. Live GUI acceptance — pending

Use a harmless command in a local pane and verify the complete visible flow:

- [ ] MCP command request appears in the renderer.
- [ ] No PTY write occurs before approval.
- [ ] Approval writes the exact approved command and executes visibly.
- [ ] Rejection produces no command execution.
- [ ] Cancellation sends Ctrl-C and reports cancellation.
- [ ] Manual MCP takeover/revocation interrupts or prevents the operation.
- [ ] Sensitive and uncertain prompts remain user-owned and fail closed.

Browser/GUI evidence should be recorded separately from automated test results.

### 2. Full Electron/PTY fixture tests — optional

Add fixture-based integration coverage for the real Electron main process and PTY boundary:

- [ ] Request-to-renderer approval round trip.
- [ ] Assert no PTY write before approval.
- [ ] Assert exactly one PTY write after approval.
- [ ] Rejection, cancellation, approval expiry, takeover, and lease revocation.
- [ ] Timeout and Ctrl-C delivery.
- [ ] Output-limit termination and truncation.
- [ ] Sensitive-prompt cancellation without returning prompt text.
- [ ] Restart does not resume pending or running MCP work.
- [ ] Unauthorized clients cannot inspect or cancel another client’s result.

### 3. Renderer audit-history view — optional

Audit records currently exist in bounded main-process memory and have a local IPC read endpoint.

- [ ] Add a typed preload bridge for audit readback.
- [ ] Add a Settings or diagnostics panel showing bounded audit events.
- [ ] Display request/session/state metadata and redacted command previews only.
- [ ] Never display bearer tokens, credentials, prompt answers, or raw terminal output.
- [ ] Add renderer tests for empty, bounded, and redacted audit histories.

### 4. Command completion policy — accepted design decision

- [x] Keep command completion timeout-based for interactive-pane execution.
- [x] Do not infer completion from shell prompts or arbitrary terminal output.
- [x] Preserve the existing pane cwd, environment, shell, and visible state.
- [x] Use bounded timeout, output capture, cancellation, and fail-closed prompt handling.

Reliable exit status would require switching to a supervised child-process model. That alternative is intentionally deferred because it would not preserve the interactive pane’s shell context.

## Pane action buttons

The AI button (bot icon, runs a configurable command such as `claude`) and the proceed button (tick icon, sends a configurable phrase) remain fixed, single-purpose controls. The AI command is also what a linked agent launches (see Pane link), which is why they were not folded into the custom list below.

### 1. Configurable custom buttons — shipped

Ten user-defined slots, numbered 0–9. Each has a label (the tooltip) and the text to send; a slot with text shows as a numbered square on every pane's top bar and types the text with Enter. Settings: `ai.customButtons`; logic in `src/renderer/pane-buttons.ts`; tests in `tests/settings.test.ts` and `tests/pane-buttons.test.ts`.

- [x] Ordered, fixed-length list in Settings, with a label and text per slot, sanitised like the proceed phrase (no newline or escape can reach the terminal).
- [x] Rendered dynamically in the pane's `pane-actions` row, only for slots that have text.
- [x] "OK, proceed" and the AI command left as they were, so existing users see no behaviour change.
- [x] Buttons are global and appear on every pane, local and SSH.
- [ ] An icon choice per button.
- [ ] An option to type the text without pressing Enter.
- [ ] More than ten slots, or reordering (slot numbers are fixed by position today).
- [ ] Per-pane-kind buttons (e.g. only offering one on local shells).

## Workspace and pane layout

- [x] Workspace rename from the tab's right-click menu. The menu closed on `pointerdown` before its item's click arrived, so no menu command ever ran; presses inside the menu no longer dismiss it (`src/renderer/context-menu.tsx`).
- [x] Choose which two panes a 2-way split shows when the workspace holds three or four: left/right arrows on each visible pane swap its slot for the next or previous pane the other slot is not showing. Saved per workspace, follows a pane that reconnects under a new session id. Logic in `src/renderer/pane-selection.ts`.
- [ ] Selecting a hidden pane in the sidebar still widens the layout to the four-pane grid; swapping it into a slot instead may suit this feature better.
- [ ] Rename gives no message when a name fails `WORKSPACE_NAME_PATTERN`; the input's `pattern` attribute normally blocks it, but a status message would be clearer.

## SSH session labels

- [x] The SSH dialog prefills "Session label" with the label last used for the host, and saves it after a successful connect. Stored in `host-labels.json` in userData, keyed on the bare lowercased host (`src/main/host-label-store.ts`, `src/renderer/host-labels.ts`).
- [ ] Labels are only saved from the dialog; reconnecting from a saved connection or restoring a pane neither reads nor writes one.
- [ ] A way to see or edit remembered labels.

## Built-in text editor

Design and decisions: `docs/editor-design.md`. Local and SSH files, up to 1 MiB, in an overlay over the panes or docked into the right-hand side of the terminal's own pane.

- [x] Local files: read and write with size, binary and UTF-8 checks; CRLF preserved; a save is refused if the file changed on disk after it was opened; writes in place so symlinks and permissions survive (`src/main/local-fs.ts`).
- [x] SSH files: read via a private temp directory, save by re-fetching and comparing content, then a plain `put` so an existing file keeps its permissions (`src/main/remote-file.ts`).
- [x] Dock beside the terminal as a sidecar, keeping the open file and unsaved edits across overlay and docked.
- [ ] Answer a password or host-key prompt from inside the editor; today it can only be answered in the transfer panel.
- [ ] Edit remote files whose names contain quotes, backslashes, wildcards or control characters.
- [ ] Remember a docked editor across restarts; more than one open file per pane.
- [ ] A true separate editor pane rather than a sidecar. Needs the pane model, persistence and session restore to learn about non-terminal panes.
- [ ] A richer widget (syntax colouring, search, large files), e.g. CodeMirror 6, behind the same `editor-state` module.
- [ ] Verify remote editing against a real host with a password-prompted login, and measure save latency.

## Pane link (agent-to-agent relay)

Design and behaviour: `docs/pane-link.md`. Plan: `.hermes/plans/2026-10-01_pane-link-agent-relay.md`.

- [x] Controller with turn cap, stall timeout, pause on busy or waiting partner, sanitised and labelled relays.
- [x] Loopback hook listener with per-agent tokens and settings files; Claude Code only.
- [x] Pane button, link menu, and per-pane status bar with Resume / Break link.
- [ ] Live GUI acceptance in the Electron app (two panes, real agents) - not yet done by a person.
- [ ] One-way relay (A to B only).
- [ ] Inject your own message mid-loop (pause, type, resume).
- [ ] Other agents (Codex, Gemini CLI) via their own turn source.
- [ ] SSH panes: needs a channel from the remote hook back to ZeroG.
- [ ] N-way links with a moderator pane or turn order, optional judge/stop condition.
- [ ] Fix `src/shared/ansi.ts` CSI pattern to cover private-parameter sequences such as `ESC[>4m`.
- [ ] Verify whether a user's own Stop hooks still run alongside the injected `--settings` hooks.

## Security boundaries

- [x] Loopback-only MCP transport.
- [x] Bearer authentication without token persistence.
- [x] Renewable single-client control lease.
- [x] Explicit capabilities and renderer approval.
- [x] No password, passphrase, OTP, host-key, or unknown-prompt automation.
- [ ] Auto-approved remote safe-list with restricted arguments.
- [x] Remote SSH commands can enter the existing explicit approval flow.

## MCP SSH session creation

- [x] Expose validated SSH session creation through MCP.
- [x] Require the `session:create` capability.
- [x] Keep authentication and host-key prompts user-controlled.
- [ ] Verify opening a session through the live MCP endpoint.

## MCP blank workspace creation

- [x] Expose blank workspace creation through MCP.
- [x] Select the new workspace and persist it immediately.
- [x] Use sequential `workspace-N` names, skipping names already stored.
- [x] Use a stable default loopback MCP port so Hermes registration survives app restarts.
