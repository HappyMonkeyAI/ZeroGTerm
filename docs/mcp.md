# ZeroGTerm local MCP control

ZeroGTerm exposes an optional, loopback-only MCP endpoint for declarative workspace and session orchestration.

## Enablement

Start ZeroGTerm with `ZEROG_MCP_ENABLED=1`. The server binds to `127.0.0.1:60056` by default and reports its endpoint in Settings under AI & voice/MCP. Authentication uses a bearer token generated for the running app. Do not commit or paste the token into source, logs, issues, or chat.

The MCP endpoint is disabled by default. The `.env` file is not a ZeroG configuration contract; pass environment variables through the process launcher or configure them in the app's normal startup environment.

## Control lease

MCP clients must acquire the single five-minute control lease before changing state. The lease can be renewed and is revoked immediately by the user from the takeover button or Settings. A second client cannot control the instance while a lease is active.

Capabilities:

- `workspace:read` and `session:read` — inspect state
- `workspace:restore` — restore a saved workspace
- `workspace:write` — create or replace a workspace
- `session:create` — create local sessions as part of an orchestration operation
- `session:close` — reserved for a future explicit close operation
- `session:execute` — request a bounded local or remote command; remote requests require renderer approval

## Available tools

- `zerog_get_connection_status`
- `zerog_acquire_control`
- `zerog_renew_control`
- `zerog_upgrade_control`
- `zerog_list_workspaces`
- `zerog_list_sessions`
- `zerog_restore_workspace`
- `zerog_create_workspace`
- `zerog_create_ssh_session`
- `zerog_create_project_workspace`
- `zerog_request_command`
- `zerog_get_command_result`
- `zerog_cancel_command`

`zerog_create_project_workspace` accepts one to four explicit local project directories, creates or reuses matching local sessions, persists the project directories for later restoration, and emits a renderer event so panes appear in the open workspace. It never runs a command.

`zerog_restore_workspace` recreates missing local sessions using the stored project directory. SSH members are recreated without credentials; authentication and host-key prompts remain user-controlled.

`zerog_create_workspace` creates and selects a blank workspace using the next available sequential name (`workspace-1`, `workspace-2`, and so on).

`zerog_create_ssh_session` opens a new SSH session in the active workspace from a validated target such as `user@host` or `user@host:port`. It does not provide credentials or answer authentication and host-key prompts; those remain visible and user-controlled in ZeroGTerm.

## Security boundary

Command execution is request-only. An agent may submit a single bounded local or remote command, but ZeroG does not write it until the user approves the exact command in the renderer. An auto-approved remote read-only safe-list is planned but is not enabled yet. Commands are limited to 512 characters, 30 seconds, and 16 KiB of retained output by default. Shell operators, control/ANSI bytes, credential-shaped content, and SSH targets are rejected.

The MCP surface never provides terminal keystroke injection, credential entry, prompt approval, or SSH secret transport. Password, passphrase, verification-code, host-key, and uncertain interactive prompts fail closed and remain user-owned. Cancellation and takeover revoke tracking and send an interrupt to the local PTY when applicable. Because a PTY does not expose trustworthy command boundaries, an otherwise non-interactive command is reported as timed out unless a future supervised runner supplies an explicit exit signal.

The selected execution model is interactive-pane execution. Approved commands run in the existing local shell so the user sees the same cwd, environment, and terminal state. ZeroG deliberately does not infer completion from shell prompts or command output: output can contain arbitrary text that resembles a prompt. Timeout is therefore the authoritative upper bound, not a claim that the command exited with a particular status. Use the returned output and visible pane state for interpretation.

Workspace and session responses contain metadata only. They do not include terminal output, passwords, private keys, bearer tokens, or API keys.

## Restart behavior

Saved local `screen` sessions can be reattached by their stable screen name. Explicit project panes also store their supplied `cwd`, allowing process-backed sessions to be recreated in the correct project directory after restart. SSH sessions are represented as reconnectable metadata and do not dial out until the user or an approved restore flow initiates the connection.

## Troubleshooting

1. Confirm `ZEROG_MCP_ENABLED=1` is present in the environment of the process that launches ZeroGTerm.
2. Restart ZeroGTerm after changing the environment.
3. Read the current endpoint and token from Settings. The default endpoint is stable at `http://127.0.0.1:60056/mcp`; an explicitly configured alternate port takes precedence.
4. Acquire a lease with the required capabilities before calling a write, restore, or command-request tool.
   If the same client already holds a lease, use `zerog_upgrade_control` to add
   capabilities; it cannot take or alter another client's lease.
5. If a workspace was created before the durable project-directory support, recreate it once with explicit project paths.
