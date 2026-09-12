# Safe Agent-Driven Terminal Control Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a constrained, observable path for an MCP agent to request terminal commands and handle approved interactive prompts without granting unrestricted shell control.

**Architecture:** Keep MCP HTTP loopback-only, bearer-authenticated, and lease-controlled. MCP requests become pending operations in the Electron main process; the renderer displays the exact request and the user explicitly approves or rejects it. Only the main process owns PTY writes and SSH prompt handling. Credentials and verification codes never enter MCP payloads, renderer state, logs, or agent-visible output.

**Tech Stack:** Electron main/preload/renderer, TypeScript, xterm.js PTY sessions, existing `McpControl`, Streamable HTTP MCP SDK, Vitest.

---

## Non-negotiable safety rules

- Do not add a generic `writeToPty(sessionId, bytes)` MCP tool.
- Do not accept shell passwords, private keys, bearer tokens, OTPs, passphrases, or host-key decisions from MCP.
- Do not execute a command merely because an agent requested it; every mutating request requires visible user approval unless the user explicitly enables a narrowly scoped, expiring automation policy.
- Render and log a redacted command preview, but retain the exact command only in the local pending operation until execution completes.
- Reject control characters, multi-line input, terminal escape sequences, shell redirection/pipelines unless the policy explicitly permits them, and commands targeting an SSH session unless the user separately authorizes remote execution.
- Bound command length, runtime, output bytes, concurrent operations, and retained history.
- Every operation must be cancellable and must report a terminal state: approved, rejected, running, completed, timed-out, cancelled, or failed.

## Phase 1: Model requests and policy before execution

### Task 1: Define operation and approval types

**Files:**
- Modify: `src/shared/types.ts`
- Test: `tests/mcp-control.test.ts` or a new `tests/mcp-execution-protocol.test.ts`

Add discriminated types for `McpExecutionRequest`, `McpExecutionPolicy`, `McpExecutionState`, `McpPromptRequest`, and `McpExecutionResult`. Include session id, request id, command preview, cwd metadata, timestamps, limits, and redaction status. Keep credentials out of every type.

Test allowed state transitions and rejection of malformed IDs, empty commands, control characters, overlong commands, invalid timeouts, and output limits.

### Task 2: Add a central command policy validator

**Files:**
- Create: `src/main/mcp-execution-policy.ts`
- Test: `tests/mcp-execution-policy.test.ts`

Implement one validator used by both MCP input and IPC input. Default policy should allow only a single-line command, no terminal escape bytes, no NUL/control characters, bounded length, bounded timeout, and local sessions only. Return structured reasons rather than throwing unclassified errors. Add explicit policy flags for shell metacharacters and remote sessions, defaulting to false.

Test common safe commands, command substitution, pipelines, redirects, ANSI escapes, embedded credentials, and SSH targets. Redact credential-shaped substrings in display text and error messages.

### Task 3: Extend the control lease with execution capability

**Files:**
- Modify: `src/main/mcp-protocol.ts`
- Modify: `src/main/mcp-control.ts`
- Test: `tests/mcp-control.test.ts`

Add a distinct `session:execute` capability. It must never be implied by `session:create`, `workspace:write`, or read capabilities. Keep the five-minute renewable lease, single-client invariant, expiry, and immediate user revocation. Add a separate short execution authorization expiry so a stale MCP request cannot run after the lease changes.

## Phase 2: Main-process broker and renderer approval

### Task 4: Build the pending-operation broker

**Files:**
- Create: `src/main/mcp-execution-broker.ts`
- Test: `tests/mcp-execution-broker.test.ts`

Create a bounded in-memory broker with at most one pending approval per session and a small global queue. It must create request IDs, expose redacted pending metadata, resolve approval/rejection exactly once, cancel on lease revocation, expire requests, and retain only bounded result metadata. It must not write to a PTY itself.

### Task 5: Add narrow main/preload IPC

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.cjs`
- Modify: `src/shared/types.ts`
- Test: `tests/mcp-execution-broker.test.ts`

Expose only `getPendingMcpExecutions`, `approveMcpExecution`, `rejectMcpExecution`, `cancelMcpExecution`, and event subscription methods. Validate every renderer payload in the main process. On approval, re-check lease, target session, policy, and expiry atomically before calling the existing session-service PTY write path.

### Task 6: Add the approval and takeover UI

**Files:**
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/settings-panel.tsx`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/icons.tsx`
- Test: `tests/settings.test.ts`, new renderer approval tests

Show a modal or pinned approval bar containing the target pane, exact command preview, cwd, whether execution is local or remote, timeout, output cap, and the approving client. Provide Approve, Reject, and Cancel. Make user takeover revoke the lease and cancel pending operations without closing panes. Show running/completed/error state in the target pane and global MCP status.

## Phase 3: MCP command request surface

### Task 7: Register a request-only MCP tool

**Files:**
- Modify: `src/main/mcp-server.ts`
- Modify: `src/main/main.ts`
- Test: `tests/mcp-server.test.ts`

Add `zerog_request_command` requiring `session:execute`. It creates a pending broker request and returns a request ID plus redacted status; it does not execute synchronously. Add `zerog_get_command_result` requiring the same client lease and request ownership. Add `zerog_cancel_command`.

The request schema must require explicit session ID and command, support optional bounded timeout/output caps, and reject SSH sessions in the first release. Never return terminal output until the user-approved operation has completed, and truncate output with an explicit marker.

### Task 8: Execute approved local commands through the existing PTY path

**Files:**
- Modify: `src/main/session-service.ts`
- Modify: `src/main/main.ts`
- Test: `tests/session-service.test.ts`, `tests/mcp-execution-broker.test.ts`

Use the existing session attachment/write abstraction, not a new shell process and not arbitrary byte injection. Append the configured line terminator only after approval. Capture bounded output associated with the request, stop on timeout, support cancellation, and mark the result based on the PTY/process exit signal where available. Ensure command output is never logged unredacted.

### Task 9: Add integration tests for approval gating

**Files:**
- Modify: `tests/mcp-server.test.ts`
- Create or modify: `tests/mcp-execution-integration.test.ts`

Prove that a request remains pending until renderer approval, rejection never writes, expired leases cannot approve, takeover cancels requests, duplicate approval is harmless, output is bounded, and unauthorized clients cannot read another client's request or result. Test that command execution is impossible when MCP is disabled.

## Phase 4: Interactive prompts and credentials, safely

### Task 10: Classify PTY prompts without exposing their answers

**Files:**
- Create: `src/main/prompt-classifier.ts`
- Test: `tests/prompt-classifier.test.ts`

Classify output patterns as ordinary output, password/passphrase, OTP/verification code, host-key confirmation, or unknown interactive prompt. The classifier may emit a prompt category and redacted text only. It must never capture or return typed secrets.

### Task 11: Route credential prompts to the user or vault only

**Files:**
- Modify: `src/main/session-service.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.cjs`
- Modify: `src/renderer/main.tsx`
- Test: `tests/session-service.test.ts`, `tests/prompt-classifier.test.ts`

For local commands, pause and show a user-owned prompt. For SSH, preserve the current manual authentication and host-key consent flow. If a saved vault integration is available, invoke it through the existing vault tool boundary; never place the secret in MCP, renderer JavaScript, operation results, logs, or chat. Verification codes require the user device flow and cannot be supplied by MCP.

### Task 12: Add fail-closed prompt tests

**Files:**
- Modify: `tests/mcp-execution-integration.test.ts`
- Test fixtures: existing session/SSH fakes

Prove that MCP cannot answer a password prompt, OTP prompt, passphrase prompt, or host-key question; the operation pauses or fails safely and asks the user. Prove prompt text is redacted in returned results and audit records.

## Phase 5: Observability, documentation, and staged rollout

### Task 13: Add bounded local audit events

**Files:**
- Create: `src/main/mcp-audit.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/mcp-server.ts`
- Test: `tests/mcp-audit.test.ts`

Record timestamp, request ID, client ID hash or stable non-secret label, capability, target session, operation state, and redacted command preview. Use a bounded rotating store. Never record bearer tokens, command output, credentials, or raw prompt answers. Expose only summary status to MCP and the UI.

### Task 14: Document the threat model and opt-in policy

**Files:**
- Modify: `docs/mcp.md`
- Modify: `SECURITY.md`
- Modify: `README.md`

Document the approval flow, local-only assumptions, lease semantics, limitations, prompt handling, redaction, command restrictions, cancellation, and recovery after a crash. Include examples that use harmless commands only. Explicitly state that enabling automation is not equivalent to granting unrestricted shell access.

### Task 15: Add staged feature flags and defaults

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/renderer/settings-panel.tsx`
- Modify: `src/main/mcp-server.ts`
- Test: `tests/mcp-server.test.ts`, `tests/settings.test.ts`

Ship request-and-approval mode first, disabled by default. Keep remote execution, shell metacharacters, unattended prompt answering, and persistent allowlists behind separate flags that cannot be enabled by an MCP request. Require an explicit local UI action for any broader policy.

### Task 16: Verify packaged and live behavior

Run:

```text
npm run test
npm run typecheck
npm run build
git diff --check
```

Then manually verify with a rebuilt ZeroG instance:

1. MCP disabled: command tool is absent or returns a clear disabled error.
2. MCP enabled: acquire `session:execute`; request `echo approval-test`.
3. Confirm no PTY write occurs before UI approval.
4. Approve and verify visible output and bounded result readback.
5. Reject, cancel, expire, and revoke from takeover; verify each terminal state.
6. Trigger password/OTP/host-key fixtures and verify MCP cannot answer them.
7. Restart ZeroG and confirm no pending command resumes automatically.
8. Confirm logs and audit files contain no secrets or raw output.

Commit each coherent phase separately. Do not push or enable unattended execution without explicit approval after live verification.

## Risks, tradeoffs, and open decisions

- A single-line command policy is safer but excludes many agent workflows; broaden only from observed needs and add tests first.
- PTY output is not a reliable exit-code protocol. A later release may add a dedicated supervised runner, but it must not become an unrestricted shell bridge.
- Remote execution should be a separate phase from local execution because SSH authentication and host-key consent have different trust boundaries.
- Decide whether approved commands are one-shot approvals or whether the user may create narrowly scoped allowlists by executable plus working-directory prefix. The default should remain one-shot.
- Decide whether command output is shown only in the pane or also returned to MCP. The safer first release returns a short bounded result and keeps full output user-visible only.
- Decide whether the user wants automation to survive app restarts. The safe default is no: pending approvals and authorizations die with the process.
