# ZeroGTerm local MCP control

ZeroGTerm exposes an optional, loopback-only MCP endpoint for declarative workspace and session orchestration.

## Enablement

Start ZeroGTerm with `ZEROG_MCP_ENABLED=1`. The server binds to `127.0.0.1` only and reports its endpoint in Settings under AI & voice/MCP. Authentication uses a bearer token generated for the running app. Do not commit or paste the token into source, logs, issues, or chat.

The MCP endpoint is disabled by default. The `.env` file is not a ZeroG configuration contract; pass environment variables through the process launcher or configure them in the app's normal startup environment.

## Control lease

MCP clients must acquire the single five-minute control lease before changing state. The lease can be renewed and is revoked immediately by the user from the takeover button or Settings. A second client cannot control the instance while a lease is active.

Capabilities:

- `workspace:read` and `session:read` — inspect state
- `workspace:restore` — restore a saved workspace
- `workspace:write` — create or replace a workspace
- `session:create` — create local sessions as part of an orchestration operation
- `session:close` — reserved for a future explicit close operation

## Available tools

- `zerog_get_connection_status`
- `zerog_acquire_control`
- `zerog_renew_control`
- `zerog_list_workspaces`
- `zerog_list_sessions`
- `zerog_restore_workspace`
- `zerog_create_project_workspace`

`zerog_create_project_workspace` accepts one to four explicit local project directories, creates or reuses matching local sessions, persists the project directories for later restoration, and emits a renderer event so panes appear in the open workspace. It never runs a command.

`zerog_restore_workspace` recreates missing local sessions using the stored project directory. SSH members are recreated without credentials; authentication and host-key prompts remain user-controlled.

## Security boundary

The MCP surface does not provide terminal keystroke injection, arbitrary command execution, shell access, credential entry, prompt approval, or SSH secret transport. This is intentional. A future command feature would require a separate design with per-pane approval, visible command confirmation, bounded output, cancellation, timeouts, and protections for interactive prompts.

Workspace and session responses contain metadata only. They do not include terminal output, passwords, private keys, bearer tokens, or API keys.

## Restart behavior

Saved local `screen` sessions can be reattached by their stable screen name. Explicit project panes also store their supplied `cwd`, allowing process-backed sessions to be recreated in the correct project directory after restart. SSH sessions are represented as reconnectable metadata and do not dial out until the user or an approved restore flow initiates the connection.

## Troubleshooting

1. Confirm `ZEROG_MCP_ENABLED=1` is present in the environment of the process that launches ZeroGTerm.
2. Restart ZeroGTerm after changing the environment.
3. Read the current endpoint and token from Settings; endpoints change when an ephemeral port is used.
4. Acquire a lease with the required capabilities before calling a write or restore tool.
5. If a workspace was created before the durable project-directory support, recreate it once with explicit project paths.
