# ZeroG Terminal — Project Context

## Purpose

ZeroG Terminal is a Linux-first terminal workspace for AI-assisted development. It combines a reliable terminal UI, persistent local and remote sessions, keyboard-driven pane layouts, and carefully controlled AI/voice workflows.

The primary user outcome is recovery: if the terminal application, SSH connection, or desktop session disappears, the work should remain alive inside a named `screen` session and be easy to rediscover and reconnect to.

## Current repository state

- Workspace: `/var/home/stephen/Documents/development/zerogterm`
- Initial state: empty directory, not yet a Git repository
- Host: Fedora 44 Silverblue
- Node.js: 22.23.2
- npm: 10.9.8
- Kitty: 0.48.2
- Toolbox: available (`toolbox` 0.3)
- Existing screen/SSH behavior: must be verified as part of the first vertical slice

## Product direction

ZeroG is not initially intended to replace every capability of Kitty or Tilix. It should provide an AI-oriented workspace around proven terminal/session components.

### Initial experience

- Launch a desktop terminal workspace.
- Create or attach to named local/remote `screen` sessions.
- Reconnect to sessions after application or network disconnection.
- Split and resize panes.
- Navigate sessions from a sidebar.
- Run AI actions with visible output and explicit approval for commands.
- Leave advanced voice, eye tracking, and plugin extensibility behind stable interfaces rather than making them first-milestone dependencies.

## Proposed technical baseline

- Electron for the desktop shell during initial development.
- TypeScript for application and service code.
- React for the workspace UI.
- xterm.js for terminal rendering.
- node-pty for local PTY access.
- System `ssh` for remote connections.
- System `screen` for persistence and reconnection.
- Vitest for unit tests.
- Playwright/Electron smoke tests after the core lifecycle works.
- Toolbox for development dependencies on Silverblue; host integration remains an explicit boundary.

## Session model

A session has durable metadata separate from the terminal renderer:

- Stable ZeroG session ID
- Host and SSH target
- Working directory
- `screen` session name
- Workspace/layout identifier
- Optional project name
- Last-known status and timestamp

The terminal renderer is disposable. The `screen` session and its processes are the durable layer.

## First vertical slice

The first implementation must prove the central reliability promise:

1. Start a local named `screen` session.
2. Attach a terminal renderer to it.
3. Type and execute a real command.
4. Close the application without killing the session.
5. Relaunch the application.
6. Discover the named session.
7. Reattach and observe the surviving state.
8. Add one split layout.
9. Show active sessions in a sidebar.
10. Add one AI command action that requires explicit user approval.

No polished plugin system, Talon integration, eye tracking, model packaging, or broad agent orchestration is required until this path is real and tested.

## AgentsProtocol adoption

Reference project: https://github.com/HappyMonkeyAI/AgentsProtocol

Verified source state at planning time:

- Repository: `HappyMonkeyAI/AgentsProtocol`
- License: MIT
- Default branch: `main`
- Reviewed commit: `e1706fdfe54ea89399800671543ed950848f864e`
- Source themes: grounding in project context, pre-mortems, planning, verification, memory, and change-impact analysis

We will adopt the useful, non-destructive parts:

- Ground work in `CONTEXT.md`, `DESIGN.md`, and later `AGENTS.md`.
- Require a written plan before substantial implementation.
- Use a pre-mortem for risky changes.
- Keep verification output tied to real commands and behaviors.
- Record architectural decisions and lessons in the repository.
- Review change blast radius before modifying session, IPC, or security boundaries.

We will not automatically adopt these behaviors:

- Automatic commits without review.
- Automatic `git reset --hard` after repeated failures.
- Autonomous destructive changes.
- Treating an agent’s self-report as proof of successful runtime behavior.
- Global installation of the protocol into unrelated projects.

Any commit automation, reset policy, or autonomous agent loop must be designed, documented, and explicitly approved later.

## Existing design references

- Kitty: https://sw.kovidgoyal.net/kitty/
- Kitty remote control: https://sw.kovidgoyal.net/kitty/remote-control/
- Tilix: https://gnunn1.github.io/tilix-web/
- Talon: https://talonvoice.com/
- AgentsProtocol: https://github.com/HappyMonkeyAI/AgentsProtocol

Kitty is the reference for fast keyboard workflows and extensibility. Tilix is the reference for tiling and session navigation. Talon is a possible future voice/eye-control adapter, not a required runtime dependency for the core terminal.

## Architecture boundaries

### Desktop/UI boundary

Electron main process owns lifecycle, native integration, PTY/service supervision, and IPC. The renderer receives only a narrow, typed preload API. Renderer code must not receive unrestricted Node.js or shell access.

### Session boundary

The session service owns `screen`, SSH, attach/detach, discovery, naming, and lifecycle errors. The UI must not construct shell commands by string concatenation.

### AI boundary

AI actions are represented as typed requests and events. Generated commands are suggestions until explicitly approved. Output capture must be bounded, cancellable, and associated with a session/task ID.

### File transfer boundary

File transfer is a separate connection to the same host, not a use of the
terminal's own. The session service owns terminals; the transfer service owns one
long-lived system `sftp` client per host, with commands serialised onto it. The
renderer sends paths and receives listings; file data never passes through it.

Transfers reuse the system client for the same reason terminals use system `ssh`:
`~/.ssh/config`, the agent, and `known_hosts` verification are then the user's
existing configuration rather than a second implementation of it. The cost is
that the client's answers are text written for a person, so parsing it is a
boundary of its own — kept pure and tested against recorded real output.

Where the remote side opens is read from the session's output, never asked for by
typing into it. A shell's working directory is not observable from outside its
pty, so the honest options are to read what the shell volunteers (OSC 7, or the
path in its prompt) or to inject a command into the user's session. Only the
first is acceptable.

### Voice boundary

Voice control uses an adapter interface. Talon, local speech recognition, or another provider may implement it later. The core terminal remains usable without voice or eye tracking.

## Security constraints

- Keep Electron `nodeIntegration` disabled.
- Keep `contextIsolation` enabled.
- Validate all IPC payloads.
- Use argument arrays or safe command builders rather than shell interpolation.
- Require confirmation for destructive or elevated commands.
- Do not place credentials, API keys, or private SSH material in this repository.
- Default network behavior to explicit user-selected hosts; do not expose a LAN service by default.
- Treat terminal output as untrusted data when passed to AI systems.
- The command history is the one store of what the user typed: off by default,
  sourced only from OSC 133 marks a shell volunteers, and refusing any command
  matching a credential shape outright rather than masking it. See SECURITY.md.

## Open questions

1. Can the Toolbox process reliably discover and attach to host-user `screen` sockets?
2. Should the development app run inside Toolbox while the session helper runs on the host?
3. Will the first release use Electron packaging, AppImage, RPM, or Flatpak?
4. Which AI agent protocols/adapters are required first?
5. What Talon functionality is available and practical on this Fedora setup?
6. Should remote sessions use `screen` directly, or support tmux as a later backend?
7. ~~What persistence store should hold workspace metadata: JSON first or SQLite from the beginning?~~
   Answered: JSON in the main process, one file per concern, written to a
   temporary file and atomically renamed. `session-history.json` holds the
   session lifecycle and `workspaces.json` holds workspace membership and
   layout (`src/main/workspace-store.ts`). Both validate on load, treat the
   file as user-editable, and swallow every failure so persistence can never
   stop a terminal from working. SQLite stays open for later, if the volume
   or the query shape ever justifies it.

## Definition of a credible first milestone

The milestone is credible only when a real terminal process survives application closure and is reattached after relaunch, with automated tests for naming/discovery and a live smoke test proving the behavior on this Fedora host.
