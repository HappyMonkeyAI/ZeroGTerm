# ZeroG Terminal

ZeroG Terminal is an Electron workspace manager for persistent terminal and SSH sessions on Linux and Windows, with smart features to help keep you productive. It is designed with AI tooling in mind: leave Codex, Claude Code, or other terminal-based agents running in persistent sessions, then return to them without repeating setup and resume commands.

ZeroG Terminal is an alpha project, but it is already useful as a multi-session terminal and SSH workspace. It uses `screen` where available for resumable sessions and falls back to a direct shell PTY when `screen` is not installed.

## Features

- Multi-pane workspaces with stack, vertical split, horizontal split, and four-pane grid layouts.
- Draggable dividers between panes and beside the sidebar, so a split does not have to be an even one. Sizes are remembered between launches.
- Maximize a focused pane and cycle between sessions without losing the other panes.
- Local sessions powered by Bash, PowerShell, WSL, and other supported shell backends; persistent sessions use `screen` where available, with a process-only fallback when it is unavailable.
- SSH sessions for hosts, `user@host`, and `user@host:port` targets.
- SSH configuration discovery from known connections, including remote `screen` session discovery.
- Reconnect to existing local or remote `screen` sessions from the Screens view.
- Remote screen attachment that waits for SSH readiness before sending commands, including host and port-aware matching.
- An SFTP transfer panel, opened from the ⇅ button above the panes: local files on the left, the active SSH session's host on the right, with upload, download, new folder, rename, and delete. It connects to the host that session is already using and opens at the directory its shell is standing in, so a file can go straight to the project being worked on.
- Session history for reconnecting to sessions after a relaunch, with bounded structured history and no stored secrets.
- Workspaces for grouping sessions and quickly switching between projects or tasks.
- Session overview, collapsible sidebar, keyboard shortcuts, and light/dark themes.
- xterm.js terminal rendering with scrollback preservation while changing layouts.
- Local voice input, either with Whisper ONNX inside the app through Transformers.js or through a transcription server on this machine; transcribed text is typed into the selected terminal without automatic execution.
- A per-pane proceed button that sends a configurable phrase — `OK, proceed` by default — for waving an agent on without typing the same reply again.
- A settings panel for appearance, terminal behaviour, session defaults, and speech recognition, including a built-in recognition test.
- AI command suggestion and approval UI, keeping command execution explicit.
- Sandboxed Electron renderer, context isolation, disabled Node integration, and a narrow typed preload API.
- Safe argument-array handling and validation around SSH and `screen` session operations.

The project is particularly useful for terminal-based AI development workflows: start an agent in a persistent session, disconnect or suffer an interrupted connection, and reconnect later to see what it has done and continue working.

See the project walkthrough on [YouTube](https://youtu.be/4aJZCxLHD14).

## Release status

ZeroG Terminal is currently a public alpha. The current release is `0.6.0-alpha.1`; the version history is tracked in [versions.txt](versions.txt).

The npm package contains the built Electron application and project documentation. It is intended for early adopters and testing rather than production use.

## Terminal shortcuts

- `Ctrl+Shift+C` — copy selected terminal text
- `Ctrl+Shift+V` — paste into the active terminal
- `Ctrl+C` remains the interrupt signal (not copy)
- `Ctrl+Shift+N` — new workspace
- `Ctrl+Shift+T` — new local terminal in the current workspace
- `Ctrl+Shift+O` — session overview
- `Ctrl+Shift+B` — toggle sessions sidebar
- `Ctrl+Shift+,` — settings
- `Esc` — close overview / dialogs, cancel voice recording

Clicking a link in a pane opens it in your own browser rather than in a window
of ZeroG. Hovering one first shows where it actually goes in the status bar,
which matters because a terminal hyperlink can be labelled with anything. Only
web links and `mailto:` addresses are opened; anything else says so in the
status bar instead, since a link in terminal output can name a scheme that would
start local software.

Selecting text with the mouse also copies it, and programs running inside a
terminal can copy to the system clipboard themselves through the OSC 52 escape
sequence — this is how TUI tools such as CLI coding agents, tmux and Neovim put
text on the clipboard, including over SSH. Reading the clipboard through OSC 52
is refused, so a program on a remote host cannot see what you last copied.

## Resizing panes and the sidebar

Drag the line between two panes, or the sidebar's right edge, to change how the
space is shared. Sizes are remembered between launches and clamped so that no
pane can be dragged down to nothing.

The dividers take keyboard focus as well: the arrow keys nudge one two percent at
a time, and Enter or a double-click puts it back in the middle. One divider
position is shared by every layout, so a split you set up in the vertical split
is the same split you get in the four-pane grid.

## Transferring files over SFTP

The ⇅ button above the panes opens a two-pane transfer panel: this computer on
the left, the active SSH session's host on the right. It is only available while
an SSH session is selected, and the button says why when it is not.

The connection is made with the system `sftp` client, so it uses the same
`~/.ssh/config`, agent, keys, and `known_hosts` as the terminal beside it. A
password, a key passphrase, or an unknown host key is asked for inside the
panel — ZeroG never answers a host-key question on your behalf, and the
fingerprint is shown with the question. Nothing typed there is stored.

The remote side opens at the directory the terminal's shell is currently in,
where that can be known without disturbing the session. ZeroG reads it from
OSC 7 — the sequence a shell emits to report its directory — and otherwise from
the path in the prompt; it never types `pwd` into your session to find out. When
neither is available the panel opens at the login directory.

Select files with a click, or several with Ctrl-click, then Upload or Download.
Double-click a folder to open it, or type a path into the folder box. New folder,
rename, and delete act on one selected item; deleting asks first, and a folder
must be empty, so a single click can never remove a tree. Folders themselves are
not transferred: a recursive copy is a different job with different failure
modes, and half-copying one silently would be worse than not offering it.

Filenames containing quotes, backslashes, or the wildcard characters `* ? [ ]`
are refused with a message rather than acted on. The `sftp` client re-reads its
own arguments through a glob pass, and there is no encoding of those characters
that is provably correct for every command — being approximately right about
which file to delete is not good enough.

## Settings

Settings open from the gear at the bottom of the left rail, the avatar in the
title bar, or `Ctrl+Shift+,`. Changes apply immediately and are remembered
between launches; each page can be reset on its own.

- **Appearance** — theme, terminal font, size, line height and letter spacing,
  with a live preview. Panes restyle in place and keep their scrollback.
- **Terminal** — scrollback lines, cursor style and blink, and copy-on-select.
- **Sessions** — default shell and WSL distribution for new terminals, the
  layout to start in, and whether the sidebar starts collapsed.
- **AI & voice** — whether AI suggestions need approval before running, and
  whether a transcript is typed straight into the pane or shown for review
  first. Neither option presses Enter for you. Also the phrase the pane's
  proceed button sends, described below.
- **Speech recognition** — engine, model and tuning, described below.

### Proceed button

Each pane's title bar carries a tick beside the microphone. Clicking it sends
`OK, proceed` and presses Enter — for the common case of an AI coding agent
pausing to ask whether it should carry on. The phrase is editable under
**Settings ▸ AI & voice**, so an agent that responds better to different wording
can have it.

This is the one control that presses Enter for you; voice transcripts and AI
suggestions deliberately do not. It sends to the pane it belongs to, so a pane
sitting at a shell prompt rather than in an agent will simply try to run the
phrase as a command.

### Speech recognition

Two engines are available.

**Built-in** runs Whisper as ONNX inside the app through Transformers.js, with
nothing else to install. Choose the model (tiny, base or small; English-only or
multilingual), the weight precision, and whether to compute on CPU (WASM) or
GPU (WebGPU) — WebGPU falls back to WASM when it is unavailable. The panel shows
the download for the chosen combination, from about 41 MB for tiny at q8 to
about 968 MB for small at full precision; models are cached after first use.
Multilingual models add language and transcribe/translate options, which
English-only checkpoints reject and so do not show.

**Local server** posts the recorded audio as a WAV file to a transcription
server on this machine, using the OpenAI `/v1/audio/transcriptions` shape that
whisper.cpp's server, LM Studio, faster-whisper-server and similar tools speak.
This is the way to use a model the built-in engine cannot load — a GGUF build
such as `unslothai/Qwen3-ASR-0.6B-GGUF` needs a llama.cpp-family runtime, so
something else has to host it. The URL must be on this machine; a non-loopback
address is refused rather than sent.

Both engines share the maximum utterance length and the silence threshold, and
the **Try it** button on that page records a phrase and shows the transcript,
the recording level and how long transcription took, without typing into a
terminal. It transcribes even below the silence threshold and says so, which is
how the threshold gets tuned for a particular microphone.

## Installation and usage

The simplest way to try the published package is through `npx`:

```bash
npx zerogterm
```

The package downloads the application and launches it. To use the launcher repeatedly without downloading on each invocation, install it globally:

```bash
npm install --global zerogterm
zerogterm
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

Node.js is the only prerequisite every host needs. The scripts above run on Linux
and Windows; npm runs them through `cmd.exe` on Windows, so no POSIX shell is
required whichever shell you start them from.

`node-pty` provides terminal I/O on every platform. It ships prebuilt binaries
for Windows and macOS, so a C/C++ toolchain is a Linux requirement rather than a
general one — there, `npm install` compiles it.

### Linux

```bash
sudo dnf install screen make gcc-c++ python3
```

`make`, `gcc-c++` and `python3` build `node-pty`. `screen` is optional but worth
having: with it, local sessions are persistent and rediscovered after relaunch.
Without it, ZeroG falls back to a direct PTY on the chosen shell and labels the
session process-only; that shell is lost when the application exits.

### Windows

No tooling beyond Node.js. The new-terminal dialog offers the shells it finds on
PATH — Windows PowerShell, PowerShell 7, Command Prompt, WSL (with a distribution
picker), and Git Bash where Git for Windows is installed.

`screen` does not exist on Windows, so local sessions are always process-only and
do not survive app exit. Remote SSH sessions are unaffected by the local shell
backend, and a remote host with `screen` still gives persistent sessions there.

## Verification

The current main branch has the following local verification coverage:

- `npm run typecheck`: passes.
- `npm test`: passes (251 tests covering session service behaviour and PTY sizing, shell discovery, SSH inventory and argument validation, remote-screen parsing and prompt readiness, session history, the session dialog, settings, terminal clipboard and OSC 52 handling, dialog dismissal, the speech and voice helpers, external link handling, and the SFTP transfer path — command quoting, listing and error parsing, authentication prompts, local filesystem operations, and working-directory detection; one further test needs a real `screen` and is opt-in through `ZEROG_LIVE_SCREEN=1`).
- `npm run build`: passes and writes `dist/main` plus `dist/renderer`.
- `npm audit --omit=dev`: production dependency auditing is part of the project quality checks.

## License

ZeroG Terminal is released under the MIT License. See [LICENSE](LICENSE).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, testing, and pull-request guidance. Please report security vulnerabilities privately through GitHub; see [SECURITY.md](SECURITY.md).
