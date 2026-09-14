# ZeroG Terminal — Project Context

## Purpose

ZeroG Terminal is a terminal workspace for AI-assisted development, supported on Linux and Windows. It combines a reliable terminal UI, persistent local and remote sessions, keyboard-driven pane layouts, and carefully controlled AI/voice workflows.

The primary user outcome is recovery: if the terminal application, SSH connection, or desktop session disappears, the work should remain alive and be easy to rediscover and reconnect to. On hosts with `screen` (Linux, and remote hosts reached over SSH), that recovery is a named `screen` session; on Windows, where `screen` does not exist, local sessions are process-only and recovery is bounded by that (see README's Windows section).

## Current repository state

- Project originated on Fedora 44 Silverblue (host: `/var/home/stephen/Documents/development/zerogterm`) and is now also developed and run on Windows.
- Node.js: 22.x; npm: 10.x+ on both platforms (see `package.json` engines/devDependencies for exact ranges in use).
- Linux dev extras: Kitty terminal, Toolbox for sandboxed dependencies — used on the original Fedora host, not required elsewhere.
- Windows: no toolbox/container requirement; `node-pty` needs a working C/C++ toolchain to build from source (see README's Windows section for the exact prerequisites).
- Shell backends are platform-dependent and resolved at runtime: Bash/screen on Linux; PowerShell, Windows PowerShell, Command Prompt, WSL, and Git Bash where present on Windows (`src/main/shell-catalog.ts`).

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
- System `ssh` for remote connections (on Windows, resolved from PATH — Git for Windows' `ssh.exe`, or another installed client).
- System `screen` for persistence and reconnection where it exists (Linux, and remote hosts reached over SSH); Windows local sessions fall back to a process-only PTY with no `screen` layer.
- Vitest for unit tests.
- Playwright/Electron smoke tests after the core lifecycle works.
- Toolbox for development dependencies on the original Fedora/Silverblue host; not used or required on Windows. Host integration remains an explicit boundary on every platform.

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
- Reviewed commit: `d520b2b20318511dd4fbd23d84b8408dce27a430` (2026-09-13; supersedes the prior `e1706fd` review, which predates ADR-0001 through ADR-0004)
- Source themes: grounding in project context, pre-mortems, planning, verification, memory, change-impact analysis, verification ladders, worktree isolation, MCP intent mapping, and adaptive model escalation

We will adopt the useful, non-destructive parts:

- Ground work in `CONTEXT.md`, `DESIGN.md`, and later `AGENTS.md`.
- Require a written plan before substantial implementation.
- Use a pre-mortem for risky changes.
- Keep verification output tied to real commands and behaviors.
- Record architectural decisions and lessons in the repository.
- Review change blast radius before modifying session, IPC, or security boundaries.
- Verification Ladder discipline (ADR-0001): for non-trivial work, "done" needs
  independent evidence, not a Worker's self-report. Build, typecheck, and the full test
  suite are the floor; a feature claim additionally needs the real behavior exercised
  (e.g. actually launching the app), not just a reading of code that should produce it.
- Evidence-bearing handoffs (ADR-0002): a handoff between sessions or to a subagent
  records the exact commands run, their real output, which paths changed, and
  commit/push status — a narrative summary of intended work is not a handoff.
- Isolated worktrees for parallel agent work (ADR-0002): if more than one agent session
  is actively editing this repo at once, each works in its own `git worktree` under
  `.worktrees/<task>` on its own branch rather than sharing one working tree; solo work
  on a clean tree does not need this ceremony.
- Failure classification before retrying (ADR-0004): tell an environmental/flaky
  failure apart from a real implementation failure before retrying it, make one focused
  repair attempt, and escalate to deeper reasoning or ask the user after that rather
  than looping on the same fix.

We will not automatically adopt these behaviors:

- Automatic commits without review.
- Automatic `git reset --hard` after repeated failures.
- Autonomous destructive changes.
- Treating an agent’s self-report as proof of successful runtime behavior.
- Global installation of the protocol into unrelated projects.
- The MCP intent map / bootstrap discovery machinery from ADR-0003: it routes agents to
  one operator's MCP catalogue (Hermes, MonkeySwarm, `dynamic_proxy`, AuditScan), none of
  which ZeroGTerm depends on. ZeroGTerm's own MCP surface is documented in this file, the
  README, and `src/main/mcp-server.ts` directly, not through that catalogue.
- Formal uSwarm roles (Architect/Manager/Worker/Owner) as a mandatory structure: useful
  vocabulary for describing a check, not a process this project's size requires.

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

As implemented: suggestions go to an OpenAI-compatible endpoint from the main process, so the API key never enters the renderer and a local server is not blocked by cross-origin rules. Terminal output is opt-in, capped, stripped of the delimiter that fences it, and labelled as untrusted data in the prompt. The guarantee does not rest on the model honouring that label: a reply is only believed when it parses into exactly one command, and approval cannot be disabled while output is being sent. Every request carries an AbortController and a timeout, and a suggestion is bound to the session id it was built from so it cannot be written into a different pane.

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
3. ~~Will the first release use Electron packaging, AppImage, RPM, or Flatpak?~~
   Answered for Windows: `electron-builder` produces an NSIS installer and a
   portable `.exe`, published to GitHub Releases (`package.json`'s `build`
   config, `npm run package:win`). Linux packaging format is still open.
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
