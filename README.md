# ZeroG Terminal

ZeroG Terminal is an Electron workspace manager for persistent terminal and SSH sessions on Linux and Windows, with smart features to help keep you productive. It is designed with AI tooling in mind: leave Codex, Claude Code, or other terminal-based agents running in persistent sessions, then return to them without repeating setup and resume commands.

ZeroG Terminal is an alpha project, but it is already useful as a multi-session terminal and SSH workspace. It uses `screen` where available for resumable sessions and falls back to a direct shell PTY when `screen` is not installed.

## Features

- Multi-pane workspaces with stack, vertical split, horizontal split, and four-pane grid layouts.
- Maximize a focused pane and cycle between sessions without losing the other panes.
- Local sessions powered by Bash, PowerShell, WSL, and other supported shell backends; persistent sessions use `screen` where available, with a process-only fallback when it is unavailable.
- SSH sessions for hosts, `user@host`, and `user@host:port` targets.
- SSH configuration discovery from known connections, including remote `screen` session discovery.
- Reconnect to existing local or remote `screen` sessions from the Screens view.
- Remote screen attachment that waits for SSH readiness before sending commands, including host and port-aware matching.
- Session history for reconnecting to sessions after a relaunch, with bounded structured history and no stored secrets.
- Workspaces for grouping sessions and quickly switching between projects or tasks.
- Session overview, collapsible sidebar, keyboard shortcuts, and light/dark themes.
- xterm.js terminal rendering with scrollback preservation while changing layouts.
- Local voice input, either with Whisper ONNX inside the app through Transformers.js or through a transcription server on this machine; transcribed text is typed into the selected terminal without automatic execution.
- A settings panel for appearance, terminal behaviour, session defaults, and speech recognition, including a built-in recognition test.
- AI command suggestion and approval UI, keeping command execution explicit.
- Sandboxed Electron renderer, context isolation, disabled Node integration, and a narrow typed preload API.
- Safe argument-array handling and validation around SSH and `screen` session operations.

The project is particularly useful for terminal-based AI development workflows: start an agent in a persistent session, disconnect or suffer an interrupted connection, and reconnect later to see what it has done and continue working.

See the project walkthrough on [YouTube](https://youtu.be/4aJZCxLHD14).

## Release status

ZeroG Terminal is currently a public alpha. The current release is `0.3.0-alpha.1`; the version history is tracked in [versions.txt](versions.txt).

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

Selecting text with the mouse also copies it, and programs running inside a
terminal can copy to the system clipboard themselves through the OSC 52 escape
sequence — this is how TUI tools such as CLI coding agents, tmux and Neovim put
text on the clipboard, including over SSH. Reading the clipboard through OSC 52
is refused, so a program on a remote host cannot see what you last copied.

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
  first. Neither option presses Enter for you.
- **Speech recognition** — engine, model and tuning, described below.

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

Runtime prerequisites on the host include Node.js and the native build tools required by `node-pty`. Install `screen` as well for persistent, discoverable sessions.

On Fedora/RHEL-like Linux systems:

```bash
sudo dnf install screen make gcc-c++ python3
```

On Windows, use a supported Node.js installation and choose PowerShell or WSL when creating a local session. WSL distributions can be selected from the local-session dialog. Remote SSH sessions work independently of the local shell backend.

`node-pty` is required for terminal I/O. When `screen` is installed, local sessions are persistent and discoverable after relaunch. Without `screen`, ZeroG falls back to a direct shell PTY and labels the session as process-only; that shell is lost when the application exits. Install `screen` for full persistence:

```bash
sudo dnf install screen
```

## Verification

The current main branch has the following local verification coverage:

- `npm run typecheck`: passes.
- `npm test`: passes (28 tests covering remote-screen parsing and prompt readiness, session history, SSH inventory and argument validation, session service behavior, and voice input helpers).
- `npm run build`: passes and writes `dist/main` plus `dist/renderer`.
- `npm audit --omit=dev`: production dependency auditing is part of the project quality checks.

## License

ZeroG Terminal is released under the MIT License. See [LICENSE](LICENSE).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, testing, and pull-request guidance. Please report security vulnerabilities privately through GitHub; see [SECURITY.md](SECURITY.md).
