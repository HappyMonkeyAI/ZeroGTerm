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

## Security boundaries

- [x] Loopback-only MCP transport.
- [x] Bearer authentication without token persistence.
- [x] Renewable single-client control lease.
- [x] Explicit capabilities and renderer approval.
- [x] Local sessions only for MCP execution.
- [x] No password, passphrase, OTP, host-key, or unknown-prompt automation.
- [x] No remote/SSH command execution.
