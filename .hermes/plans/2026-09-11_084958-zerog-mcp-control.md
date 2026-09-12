# ZeroG MCP Control Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add an opt-in, local-only MCP control surface that lets a trusted desktop agent inspect and restore ZeroG workspaces and create/manage explicitly AI-controlled terminal panes without silently executing dangerous work.

**Architecture:** Keep MCP as a narrow command/control API in the Electron main process, behind an explicit user-enabled local connection and a per-connection capability/lease. Reuse the existing session service, workspace store, IPC validation, and renderer state rather than allowing MCP to manipulate the renderer directly. Treat workspace restoration as the first-class use case; terminal command execution is a separate, more restricted capability.

**Tech Stack:** Electron main process, TypeScript, existing preload IPC bridge, existing `ScreenService`, `WorkspaceStore`, React renderer, Vitest. Confirm the current official TypeScript MCP SDK and transport API before adding a dependency.

---

## Product decisions and pushback

1. Do not model this as an AI-owned pane versus a human-owned pane. Model it as a pane with an AI control lease. The user can revoke the lease instantly, and a pane can return to ordinary manual use without being destroyed.
2. Do not let an MCP client type arbitrary keystrokes by default. A generic `write(sessionId, text)` API makes shell prompts, SSH authentication, destructive commands, and pasted scripts indistinguishable. Start with workspace/session orchestration and a separately gated `execute` operation.
3. The stop control must be an emergency revoke, not merely a disconnect indicator. Revocation should cancel pending MCP calls, prevent new writes, and leave the terminal visible and manually usable.
4. Use a four-state indicator rather than only green/red/grey: not controlled, connecting, controlled, and control revoked/error. Green should mean an active lease, not merely that an MCP server is listening.
5. Restore should be declarative and idempotent: "make workspace X look like this". Repeated requests must not create duplicate panes or duplicate SSH connections.
6. Never return terminal output or workspace data by default unless the MCP tool explicitly requests it. Output is sensitive and may contain credentials or hostile prompt-injection text.

## Suggested MVP MCP tools

Read-only first:

- `zerog_list_workspaces` — names, ids, layout, pane metadata, pending restore state.
- `zerog_list_sessions` — session id, name, kind, host, cwd, status, AI-control state; no credentials or raw output.
- `zerog_get_connection_status` — MCP listener state, active client identity, lease state, and capabilities.

Workspace orchestration:

- `zerog_restore_workspace` — select an existing workspace and request restoration of resumable panes; return a structured per-pane result. SSH reconnect must remain user-approved unless the user has explicitly enabled unattended reconnect.
- `zerog_create_workspace` — create an empty workspace with a validated name/layout.
- `zerog_select_workspace` — make a workspace visible without changing pane ownership.
- `zerog_create_local_session` — create a local pane using an allowlisted backend and validated cwd.
- `zerog_create_ssh_session` — create an SSH pane only when the connection target is an existing known connection or the user has enabled arbitrary targets.
- `zerog_close_session` — require an explicit session id and return the resulting state.

Separate, later capability:

- `zerog_execute_command` — only after a pane-level AI lease is granted, with command text shown in the pane/UI, configurable approval policy, timeout, output cap, and cancellation. Do not expose raw terminal writes as the public MCP primitive.

## Control and permission model

- MCP is disabled by default and enabled from Settings.
- Bind only to `127.0.0.1`; never bind all interfaces.
- Generate a random bearer token per app profile and store it through the existing secret-store mechanism. Do not place it in renderer localStorage or logs.
- Show the endpoint/token setup only through a masked user-facing flow; never print the token in status logs.
- Identify one connected client at a time for MVP. A second client is rejected or requires explicit takeover.
- Give the client a short-lived control lease. Renewal is explicit and observable; expiry automatically revokes AI control but does not close panes.
- Cap concurrent operations and set deadlines on every request.
- Add an audit event for connect, lease grant/renew/revoke, pane create/close, workspace restore, command approval, and command cancellation. Keep command text out of the audit log unless the user has opted into command history.
- Redact or omit SSH targets, cwd, and output from responses where the user has configured sensitive-data minimisation.

## Step-by-step implementation plan

### Task 1: Document the protocol boundary and threat model

**Files:**
- Modify: `SECURITY.md`
- Modify: `README.md` (if the project has an integrations/configuration section)
- Create: `docs/mcp.md`

Define local-only binding, authentication, lease semantics, tool naming, sensitive fields, and the distinction between orchestration and command execution. Include explicit non-goals: no remote network exposure, no automatic host-key acceptance, no password/passphrase handling, no unrestricted shell injection.

Verify the documentation names the actual existing security boundaries: sandboxed renderer, narrow preload API, argument arrays, secret store, SSH prompt handling, and workspace metadata rules.

### Task 2: Add MCP domain types and pure validation

**Files:**
- Modify: `src/shared/types.ts`
- Create: `src/main/mcp-protocol.ts`
- Test: `tests/mcp-protocol.test.ts`

Add types for MCP connection state, capability set, lease, operation result, pane control metadata, and restore results. Implement pure validators for tool arguments, workspace names, session ids, layouts, allowlisted shell backends, output limits, deadlines, and capability checks.

Write tests first for malformed arguments, unknown ids, oversized values, missing capability, expired lease, and safe defaults.

### Task 3: Add a main-process control coordinator

**Files:**
- Create: `src/main/mcp-control.ts`
- Test: `tests/mcp-control.test.ts`
- Modify: `src/main/main.ts`

Build a coordinator that owns connection identity, capability grants, lease expiration, pending-operation cancellation, and AI-control metadata. It should call existing services rather than duplicate PTY/session logic. Revoking control must be synchronous from the coordinator's perspective: no later write or command operation may pass the lease check.

Expose a small internal interface first, independent of the MCP transport, so it can be exercised with fake session/workspace services.

### Task 4: Add the local MCP transport/server

**Files:**
- Create: `src/main/mcp-server.ts`
- Modify: `package.json`
- Modify: `src/main/main.ts`
- Test: `tests/mcp-server.test.ts`

Use the current official MCP TypeScript SDK after checking its supported Electron/Node transport APIs. Prefer an app-owned loopback Streamable HTTP endpoint with an unpredictable port and bearer token, because Hermes can connect to an already-running ZeroG instance. If the SDK or Electron packaging makes that unreliable, use a small stdio companion process plus an authenticated loopback bridge; do not expose an unauthenticated stdio-equivalent socket.

Implement JSON-schema-like argument validation at the tool boundary, structured errors, request deadlines, cancellation, one-client policy, and clean shutdown when the window/app closes. Do not log bearer tokens, raw arguments containing command text, or terminal output.

Test tool discovery, auth rejection, malformed calls, lease rejection, cancellation, shutdown, and per-tool result shapes.

### Task 5: Extend the preload API only for user-visible connection state

**Files:**
- Modify: `src/shared/types.ts`
- Locate/modify: the generated or source preload bridge used by `src/renderer/main.tsx`
- Test: add/update the relevant IPC/preload tests discovered during implementation

Expose only status, enable/disable, revoke-control, and safe setup actions needed by the Settings/UI. MCP operations must not be callable from the renderer just because the renderer has a `window.zerog` object. Keep token material out of returned renderer state; use a masked setup/copy flow if needed.

### Task 6: Add pane-level AI control state and indicators

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/icons.tsx`
- Modify: `src/renderer/styles.css`
- Test: `tests/pane-listing.test.ts` or a new `tests/ai-control-view.test.ts`

Add AI-control metadata to session/pane view state without changing durable workspace member identity. Render a compact accessible indicator in each controlled pane/session row. Recommended states:

- grey: ordinary/manual pane
- amber/blue or pulsing neutral: control connection negotiating
- green: active AI lease
- red: revoked, expired, or failed

Do not rely on color alone: provide a title/aria-label and a visible state string in the pane menu or status area.

### Task 7: Add the emergency revoke/takeover control

**Files:**
- Modify: `src/renderer/main.tsx`
- Modify: `src/renderer/icons.tsx`
- Modify: `src/renderer/styles.css`
- Test: new UI/state tests for revoke behavior

Add a clearly labelled stop/takeover button in the app chrome and pane controls. Clicking it must revoke the lease, cancel in-flight AI operations, disable future AI writes, and keep panes alive. The button should be available even when the AI connection is degraded. Add a confirmation only for broad "disconnect all"; do not add one for the emergency stop action.

### Task 8: Implement declarative workspace restoration

**Files:**
- Modify: `src/main/workspace-store.ts` if schema/version changes are required
- Modify: `src/main/mcp-control.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/main.tsx`
- Test: `tests/session-restore.test.ts`, `tests/workspace-view.test.ts`, new MCP integration tests

Make `restore_workspace` reuse the existing pending-pane/session-restore semantics. It must report each pane as already-running, reattached, awaiting-user-consent, skipped, or failed. It must preserve layout, active pane, focused pane, and pending panes. SSH and remote screen reconnects must not bypass current explicit consent rules unless a separate user setting enables it.

Exercise the same request twice and verify no duplicate sessions, duplicate workspace membership, or conflicting focus state.

### Task 9: Add optional command execution as a separately reviewed slice

**Files:**
- Modify: `src/main/mcp-control.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/main.tsx`
- Modify: `src/shared/types.ts`
- Test: new command approval/cancellation/redaction tests
- Modify: `SECURITY.md`

Only begin this task after the orchestration MVP is stable. Implement command execution through a structured operation, not arbitrary terminal keystrokes. Require a pane lease, show the command and target pane, enforce the current approval setting or an MCP-specific stricter policy, cap output, apply timeout/cancellation, and record an outcome. Never let terminal output become instructions to subsequent operations.

### Task 10: End-to-end verification and release notes

**Files:**
- Modify: `README.md`
- Modify: `docs/mcp.md`
- Add tests/fixtures as needed

Run:

- `npm run test`
- `npm run typecheck`
- `npm run build`

Then run the packaged/dev app and verify with a real MCP client or protocol fixture: enable the server, authenticate, list workspaces, restore yesterday's workspace, observe pane indicators, revoke control, confirm the panes remain manually usable, and confirm a revoked client cannot create/write/close panes. Verify the listener is loopback-only and that no token, password, passphrase, or terminal output appears in logs.

## Likely files to change

- `src/main/main.ts`
- `src/main/mcp-server.ts` (new)
- `src/main/mcp-control.ts` (new)
- `src/main/mcp-protocol.ts` (new)
- `src/shared/types.ts`
- `src/renderer/main.tsx`
- `src/renderer/icons.tsx`
- `src/renderer/styles.css`
- `src/main/workspace-store.ts` only if schema evolution is needed
- `package.json`
- `SECURITY.md`
- `README.md`
- `docs/mcp.md` (new)
- `tests/mcp-protocol.test.ts` (new)
- `tests/mcp-control.test.ts` (new)
- `tests/mcp-server.test.ts` (new)

## Acceptance criteria

- Disabled by default; no listening endpoint exists until the user enables it.
- Endpoint is loopback-only and authenticated.
- One client/lease is visible and revocable.
- Restore and workspace orchestration are idempotent and preserve existing SSH consent rules.
- AI-controlled panes are visibly and accessibly marked.
- Emergency revoke takes effect immediately and leaves panes available for manual use.
- No secret material or unbounded terminal output crosses the MCP boundary.
- `npm run test`, `npm run typecheck`, and `npm run build` pass.
- A real end-to-end client interaction is verified rather than inferred from unit tests.

## Open questions before implementation

1. Should ZeroG own the loopback MCP endpoint, or should Hermes launch a stdio adapter? The app-owned endpoint best matches "ask Hermes to reopen the running app," while a stdio adapter is simpler to configure and package.
2. Is one connected MCP client enough for the first release? It is safer and makes takeover semantics clear.
3. Should SSH reconnect be user-approved every time, or can the user opt into unattended reconnect for named known connections only?
4. Should command execution be in the first release? Recommendation: no; ship workspace/session orchestration first and learn from real use.
5. Should the AI indicator identify the client name, e.g. "Hermes controls this pane," in addition to the generic state?
