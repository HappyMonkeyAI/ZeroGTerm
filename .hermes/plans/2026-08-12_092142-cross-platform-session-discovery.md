# Cross-Platform Sessions and Session Discovery Implementation Plan

> **For Hermes:** Use this plan as the implementation brief after product decisions are confirmed.

**Goal:** Extend ZeroG Terminal beyond Linux/bash by supporting Windows PowerShell and WSL, while reorganizing the sidebar around active terminals, reusable connections, durable screen sessions, and historical sessions.

**Architecture:** Keep terminal backends behind a typed main-process session service. Add explicit backend/session metadata rather than inferring behavior from display labels. Make sidebar sections/tabs a renderer presentation of separate data sets: active terminals, known connections, discoverable durable sessions, and history. Use safe argv-based process spawning and SSH configuration parsing; remote screen discovery/attachment must be modeled as an SSH-backed operation, not as a local screen session.

**Tech Stack:** Electron, TypeScript, React, xterm.js, node-pty, existing `ScreenService`, Electron IPC/preload, Vitest.

---

## Product interpretation

The request contains four related features:

1. **Additional local terminal backends**
   - Windows PowerShell as a selectable local shell on Windows.
   - WSL as a selectable local shell, likely with distribution selection where available.
   - The current Linux shell/screen behavior remains supported.
   - The UI should identify the backend clearly: for example `PowerShell`, `WSL · Ubuntu`, `bash`, or `zsh` rather than displaying every local session as `bash`.

2. **Durable/discoverable sessions**
   - Existing local `screen` sessions should be discoverable after relaunch.
   - Discovered sessions should appear below active sessions in a subdued/ghosted presentation because they are not currently attached to a ZeroG pane.
   - Clicking one should attach/reconnect to it quickly.
   - For a remote host, the intended flow is to reconnect through SSH and then attach to a still-running remote `screen` session if it exists. This requires explicit remote discovery and a safe remote attach command; it is not equivalent to the current local `screen -ls` implementation.

3. **Sidebar navigation frame**
   - The current separator/tools area beneath the workspace header should become a tabbed frame.
   - Initial conceptual tabs are `Terminals`, `Screens`, and `Connections`/`Remote`.
   - `Terminals` shows active sessions attached to or available in the current workspace.
   - `Screens` shows discoverable durable sessions, with inactive sessions visually faded.
   - `Connections` shows reusable known SSH connections, including entries sourced from the host's SSH configuration.
   - Exact tab naming and whether `Remote` and `Connections` are one tab or two should be confirmed before implementation.

4. **History access**
   - Add a compact history icon beside the existing plus control in the drawer header, matching the plus button's dimensions.
   - It opens historical sessions/connection events, distinct from currently discoverable screen sessions.
   - History should be persisted with enough metadata to reconnect or explain why a prior session is unavailable; it must not promise that an ended SSH session can be restored.

## Current repository context

- Session domain types are in `src/shared/types.ts`.
- Process discovery, local screen creation/attachment, SSH target validation, and PTY management are in `src/main/session-service.ts`.
- IPC handlers are in `src/main/main.ts`; the typed renderer bridge is in `src/main/preload.cjs`.
- Sidebar rendering and workspace/session state are in `src/renderer/main.tsx`; sidebar styling is in `src/renderer/styles.css`.
- Existing tests are in `tests/session-service.test.ts`.
- Current local fallback is direct `bash` when `screen` is unavailable. The current implementation already parses local `screen -ls` output and keeps screen-backed sessions discoverable.
- Existing verification commands are `npm run typecheck`, `npm test`, and `npm run build`; the Electron terminal skill also requires a bounded live startup smoke.

## Proposed data model

Extend the session model without overloading `SessionKind`:

- `SessionBackend`: `bash`, `zsh`, `powershell`, `wsl`, `ssh`, `screen` or equivalent typed backend metadata as appropriate.
- `SessionScope`: `local` or `remote`.
- `SessionSource`: `active`, `discovered`, `known-connection`, or `history` should generally be renderer/view state, not duplicated in the persisted process record.
- Durable sessions need a stable identity that includes host/scope and screen name, not only `local:<name>`.
- Known SSH connections need alias, hostname/user/port, optional identity-file metadata without exposing private key contents, and the source/config path.
- History entries need timestamps, display name, backend, target/alias, screen name if relevant, and last-known availability.

Do not persist secrets, private key contents, or arbitrary shell command strings. Use validated structured arguments and existing argv-based spawning.

---

## Implementation phases

### Phase 1: Confirm product decisions and platform contract

**Objective:** Resolve the choices that materially affect the model and UX before editing code.

Decide:

- Is PowerShell supported only when ZeroG runs on Windows, or should a Linux host also expose `pwsh` when installed?
- Is WSL represented as one generic backend or as a selectable distribution (`wsl.exe -d <distro>`)?
- Should WSL sessions be screen-backed inside WSL when `screen` exists, or process-only initially?
- Should `Screens` include local screens only in the first release, with remote screen discovery as a follow-up, or must remote discovery be included in the first slice?
- Should `Connections` include only `~/.ssh/config` host aliases, or also recent manually entered SSH targets?
- Should the tabs filter the current workspace or act as global inventories?
- What is the retention policy for history, and should history be stored in a JSON file, Electron `app.getPath('userData')`, or another store?

### Phase 2: Backend abstraction and shell discovery

**Files likely to modify:**

- `src/shared/types.ts`
- `src/main/session-service.ts`
- `src/main/main.ts`
- `src/main/preload.cjs`
- `tests/session-service.test.ts`

Steps:

1. Add typed backend and session metadata while retaining compatibility with existing local/SSH records.
2. Add platform-aware shell discovery:
   - Windows: PowerShell 7 (`pwsh`) if installed, then Windows PowerShell (`powershell.exe`) as appropriate.
   - WSL: detect `wsl.exe`, enumerate distributions with a non-interactive command, and validate a selected distribution name before placing it in argv.
   - Linux/macOS-compatible behavior: preserve the existing default shell and optionally expose `pwsh` only if it is actually installed.
3. Add a typed create-session request that selects the backend and optional WSL distribution.
4. Spawn shells with executable/argv arrays; do not build shell-interpolated commands.
5. Define behavior when a requested executable is unavailable: return a clear typed error and show the install/configuration requirement in the UI.
6. Add unit tests for shell discovery normalization, WSL distribution parsing, backend selection, and unsafe distribution/argument rejection.

### Phase 3: Local and remote screen discovery/attachment

**Files likely to modify:**

- `src/shared/types.ts`
- `src/main/session-service.ts`
- `src/main/main.ts`
- `src/main/preload.cjs`
- `tests/session-service.test.ts`

Steps:

1. Refactor local screen parsing into a discovery result that explicitly marks sessions as detached/discovered rather than treating every listed session as an active workspace session.
2. Preserve stable IDs and avoid collisions between local and remote screen sessions.
3. Add a local screen attach path that reconnects a discovered screen safely.
4. Add remote screen discovery as a separate operation:
   - establish an SSH command using validated structured target data;
   - run a constrained remote `screen -ls` query without local shell interpolation;
   - parse the remote result with host-qualified IDs;
   - retain enough metadata to issue a later remote attach command.
5. Define failure states separately: host unreachable, SSH authentication failure, screen unavailable remotely, and screen session no longer present.
6. Add tests for local and remote screen output parsing, stable IDs, and command argument construction. Add an integration/live smoke only where the environment provides a safe test host.

### Phase 4: SSH config and reusable connections

**Files likely to modify:**

- `src/shared/types.ts`
- `src/main/session-service.ts` or a new `src/main/ssh-config.ts`
- `src/main/main.ts`
- `src/main/preload.cjs`
- `tests/ssh-config.test.ts` (new)

Steps:

1. Parse the user's SSH config using a conservative parser for `Host`, `HostName`, `User`, `Port`, and optionally `IdentityFile` metadata.
2. Respect multiple host aliases and skip wildcard-only entries from the clickable known-connections list unless a later design explicitly wants them.
3. Never read or expose private key contents; only retain paths if needed for display/diagnostics and pass through validated SSH configuration behavior.
4. Add an IPC endpoint to list known connections and a create/connect action using an alias.
5. Decide whether manually entered SSH targets are also saved as recent reusable connections, and if so, store only structured non-secret metadata.
6. Add fixture-based parser tests for aliases, comments, whitespace, duplicate keys, wildcard entries, and missing config files.

### Phase 5: Sidebar tabbed frame and ghosted sessions UI

**Files likely to modify:**

- `src/renderer/main.tsx`
- `src/renderer/styles.css`
- possibly `src/shared/types.ts`
- renderer/component tests if added to the project

Steps:

1. Replace the current two-button drawer tool row with a typed tab state, initially `terminals`, `screens`, and `connections`.
2. Keep the existing plus action semantically as “new local terminal”; add an adjacent history icon button with an accessible label and tooltip.
3. Render active workspace sessions in `Terminals`.
4. Render local/remote discovered screens in `Screens`, separated from active sessions and styled as subdued/ghosted when detached or not currently attached.
5. Clicking a discovered screen should attach it, claim it into the current workspace where appropriate, focus it, and update the status surface with the reconnect result.
6. Render known SSH connections in `Connections`; clicking one should use the existing workspace/session creation path without duplicating aliases unnecessarily.
7. Add clear empty, loading, stale, unavailable, and error states for each tab.
8. Add backend-specific labels and icons/secondary text for `bash`, PowerShell, WSL distribution, SSH, and screen.
9. Ensure the sidebar remains usable at its current minimum window size and preserve the existing collapsed drawer behavior.
10. Add the history overlay/popover. It should distinguish “reconnectable screen,” “known connection,” and “ended/unavailable” entries.

### Phase 6: History persistence and lifecycle integration

**Files likely to modify:**

- `src/main/session-service.ts` or new `src/main/session-history.ts`
- `src/main/main.ts`
- `src/main/preload.cjs`
- `src/shared/types.ts`
- `src/renderer/main.tsx`
- `tests/session-history.test.ts` (new)

Steps:

1. Choose an Electron user-data location and versioned JSON schema for history.
2. Record session creation, attach, detach/close, and failed reconnect events with bounded retention.
3. Load history defensively; tolerate missing, corrupt, or older files without preventing app startup.
4. Expose history through narrow IPC and keep writes in the main process.
5. Add a clear-history action only if desired; otherwise make retention automatic and bounded.
6. Add tests for persistence round trips, malformed files, retention, redaction, and reconnectability labels.

### Phase 7: Verification and documentation

**Files likely to modify:**

- `README.md`
- possibly platform-specific troubleshooting documentation

Verification:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `git diff --check`
5. Confirm built preload and renderer assets exist.
6. Run a bounded Electron startup smoke with logging.
7. On Linux, live-test local screen discovery, attach, marker output, detach, rediscovery, and cleanup.
8. On Windows, live-test PowerShell and WSL discovery/creation if a Windows test host is available.
9. On a test SSH host, live-test known-config connection and remote screen discovery/attach separately from unit tests.
10. Update README with supported platform prerequisites, backend behavior, persistence limitations, and remote screen requirements.

## Risks and tradeoffs

- **Remote screen attach is more complex than local discovery.** It requires SSH lifecycle handling, remote command quoting, host-qualified identity, and clear authentication/error states.
- **PowerShell and WSL are Windows-specific in their native form.** Supporting `pwsh` on Linux is useful but should not be confused with Windows PowerShell support.
- **WSL persistence is ambiguous.** A WSL shell can be durable only if a session manager exists inside the selected distribution; otherwise it should be labeled process-only.
- **SSH config is richer than the first-pass parser.** Include only well-understood keys initially and document unsupported directives rather than silently misrepresenting them.
- **History can become misleading.** Historical entries must show last-known status and should never imply that an ended SSH process is recoverable.
- **Workspace versus global inventory needs a deliberate rule.** A discovered screen or known connection may be global, while attaching it should claim it into the active workspace; this should be consistent and visible.
- **Security boundary must remain unchanged.** No shell interpolation, no credential/key material in renderer state, and no broad filesystem or process APIs in preload.

## Suggested first vertical slice

For the lowest-risk reviewable increment:

1. Add the typed sidebar tabs and ghosted local screen section.
2. Separate discovered local screen sessions from active workspace sessions.
3. Add history icon and a read-only history view backed by in-memory/session-lifetime data initially, or proceed directly to user-data persistence if durable history is a firm requirement.
4. Add shell backend metadata and local PowerShell/WSL discovery behind platform checks, with creation UI.
5. Add SSH config parsing and known connections after the core tab model is accepted.
6. Implement remote screen discovery/attachment as its own vertical slice after the local behavior and error model are proven.

This ordering preserves the existing working local screen behavior while making the UI and data model ready for the broader connection inventory.