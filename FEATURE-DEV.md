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

The AI button (bot icon, runs a configurable command such as `claude`) shipped as a second hardcoded button alongside the existing proceed button (tick icon, sends a configurable phrase), following the same settings-field-and-button pattern. Both remain fixed, single-purpose controls — there is still no generic mechanism for the user to define their own set of pane buttons.

### 1. Configurable custom buttons — proposed

- [ ] Replace the two hardcoded fields (`proceedPhrase`, `aiCommand`) with an ordered list of user-defined entries, each with a label, an icon choice, the text to send, and whether it presses Enter.
- [ ] Add/remove/reorder UI in the Settings panel (the app's first array-based settings editor — no existing list-editing pattern to copy from).
- [ ] Render the list dynamically in the pane's `pane-actions` row instead of two fixed `<button>` elements.
- [ ] Keep "OK, proceed" and the AI command as the two seeded defaults, so existing users see no behavior change on upgrade.
- [ ] Decide whether buttons are global or per-pane-kind (e.g. only offering the AI button on local shells, not SSH panes).

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
