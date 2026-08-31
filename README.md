# ZeroG Terminal

ZeroG Terminal is an Electron workspace manager for persistent terminal and SSH sessions on Linux and Windows, with smart features to help keep you productive. It is designed with AI tooling in mind: leave Codex, Claude Code, or other terminal-based agents running in persistent sessions, then return to them without repeating setup and resume commands.

ZeroG Terminal is an alpha project, but it is already useful as a multi-session terminal and SSH workspace. It uses `screen` where available for resumable sessions and falls back to a direct shell PTY when `screen` is not installed.

## Features

- Multi-pane workspaces with stack, vertical split, horizontal split, and four-pane grid layouts.
- Draggable dividers between panes and beside the sidebar, so a split does not have to be an even one. Sizes are remembered between launches.
- A compact navigation rail for sessions, overview, settings, SSH connections, and opening a new local terminal, while keeping the sessions sidebar collapsible.
- Layout controls that restore a split, even up its pane sizes, and maximize or restore a pane in a predictable sequence.
- Maximize a focused pane and cycle between sessions without losing the other panes.
- Local sessions powered by Bash, PowerShell, WSL, and other supported shell backends; persistent sessions use `screen` where available, with a process-only fallback when it is unavailable.
- SSH sessions for hosts, `user@host`, and `user@host:port` targets.
- SSH configuration discovery from known connections, including remote `screen` session discovery. In the sidebar's Connections tab, clicking a saved connection opens the connect dialog with the host filled in, and double-clicking it skips the dialog and opens the host in a new pane.
- Reconnect to existing local or remote `screen` sessions from the Screens view.
- Remote screen attachment that waits for SSH readiness before sending commands, including host and port-aware matching.
- Shared ports over SSH, in a Ports view opened from the rail: forward a port on a remote host so it answers on this machine, or a port here so it answers on the remote. Each tunnel is its own SSH connection, so a host needs no terminal open first. Ports bind to loopback unless you widen them, and are remembered between launches.
- An SFTP transfer panel, opened from the ⇅ button above the panes: local files on the left, the active SSH session's host on the right, with upload, download, new folder, rename, and delete. It connects to the host that session is already using and opens at the directory its shell is standing in, so a file can go straight to the project being worked on.
- Session history for reconnecting to sessions after a relaunch, with bounded structured history and no stored secrets.
- A ranked command palette on `Ctrl+Shift+R`, in the spirit of [McFly](https://github.com/cantino/mcfly): commands you have run, ranked by directory, host, recency, frequency, whether they worked, and whether you picked them before. Off by default — it is the one feature that stores what you typed — and it refuses anything that looks like it carries a credential.
- Workspaces for grouping sessions and quickly switching between projects or tasks. Each workspace keeps its own panes, layout, focused terminal, and maximized pane, so switching to one restores the arrangement you left it in. Workspaces survive a relaunch: local `screen` terminals reattach on their own, and SSH panes come back as ghost rows that reconnect when clicked, rather than dialling out to a host on startup.
- Session overview, collapsible sidebar, keyboard shortcuts, and light/dark themes.
- xterm.js terminal rendering with scrollback preservation while changing layouts.
- Voice input, either with Whisper ONNX inside the app through Transformers.js or through an OpenAI-compatible transcription server you point it at — on this machine, on the LAN, or hosted; transcribed text is typed into the selected terminal without automatic execution.
- A per-pane proceed button that sends a configurable phrase — `OK, proceed` by default — for waving an agent on without typing the same reply again.
- A settings panel for appearance, terminal behaviour, session defaults, and speech recognition, including a built-in recognition test.
- AI command suggestions from any OpenAI-compatible endpoint — Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, or OpenAI itself — configured with a base URL, a model and an optional key in Settings. Ask what you want, get one command with an explanation, and approve it before it runs.
- Sandboxed Electron renderer, context isolation, disabled Node integration, and a narrow typed preload API.
- Safe argument-array handling and validation around SSH and `screen` session operations.

The project is particularly useful for terminal-based AI development workflows: start an agent in a persistent session, disconnect or suffer an interrupted connection, and reconnect later to see what it has done and continue working.

See the project walkthrough on [YouTube](https://youtu.be/4aJZCxLHD14).

## Release status

ZeroG Terminal is currently a public alpha. The current release is `0.7.0-alpha2`; the version history is tracked in [versions.txt](versions.txt).

The npm package contains the built Electron application and project documentation. It is intended for early adopters and testing rather than production use.

## Terminal shortcuts

- `Ctrl+Shift+C` — copy selected terminal text
- `Ctrl+Shift+V` — paste into the active terminal
- `Ctrl+C` remains the interrupt signal (not copy)
- `Ctrl+Shift+N` — new workspace
- `Ctrl+Shift+1` … `Ctrl+Shift+9` — switch to a workspace by position
- `Ctrl+Shift+T` — new local terminal in the current workspace
- `Ctrl+Shift+R` — ranked command history palette
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

## The command history palette

`Ctrl+Shift+R` opens a search over the commands you have actually run, ranked so
the one you want is usually first: same directory beats same host, recent beats
frequent, something that worked beats something that failed, and something you
picked from this palette before beats something you merely ran. Typing matches a
subsequence, so `gcm` finds `git commit -m`, and the matched characters are
highlighted so it is clear why a row is there.

Enter puts the command on the prompt **without running it**. The command came out
of a store rather than from your hands a moment ago, so pressing Enter is your
decision — and it leaves room to change an argument, which is most of why anyone
reaches for history.

`Ctrl+R` is untouched. Your shell keeps its own reverse search; McFly can rebind
that key because it *is* the shell, and ZeroG taking it would remove
reverse-search from every pane including remote ones this feature cannot see.

### Turning it on

Recording is off until you switch it on in Settings under "AI & voice". It is the
only part of ZeroG that stores what you typed, so it is opt-in rather than a
default you have to find and disable.

Commands are read from the standard OSC 133 prompt marks a shell emits — the same
marks VS Code, kitty, WezTerm and Windows Terminal use. If you already have shell
integration from any of those, or from an oh-my-zsh plugin, ZeroG reads what is
already there and you need to add nothing. Otherwise Settings offers a snippet
per shell to paste into your rc file, and the panel says how many of your open
panes are actually reporting marks, so "did that work" has an answer.

A remote host needs the snippet installed on the remote host: the marks come from
the shell, and over SSH that shell is on the far side. A pane whose shell reports
no marks records nothing, rather than guessing from the screen and recording
something wrong.

### What is stored, and what is refused

Each entry holds the command, the directory and host it ran in, its exit status,
when it last ran, how many times, and how often you picked it. It lives in
`command-history.json` in ZeroG's profile directory, written with owner-only
permissions. "Forget all remembered commands" empties it and deletes the file.

A command that looks like it carries a credential is refused outright rather than
stored with the value masked — a masked entry still records that you set a
particular secret in a particular directory at a particular time. Refused shapes
include assignments to anything named like a token, key, secret or password;
`--password`, `--token` and `--api-key` flags; credentials inside a URL;
`Authorization` headers; `curl -u user:pass`; vendor-shaped tokens; and long
high-entropy words.

This is not a complete defence and is not claimed to be. A secret typed as a bare
argument to an unusual program, or piped in from `echo`, looks like ordinary text.
See [SECURITY.md](SECURITY.md).

## Resizing panes and the sidebar

Drag the line between two panes, or the sidebar's right edge, to change how the
space is shared. Sizes are remembered between launches and clamped so that no
pane can be dragged down to nothing.

The dividers take keyboard focus as well: the arrow keys nudge one two percent at
a time, and Enter or a double-click puts it back in the middle. One divider
position is shared by every layout, so a split you set up in the vertical split
is the same split you get in the four-pane grid.

## Sharing ports over SSH

The Ports button in the rail opens a list of shared ports, grouped by the host
each one runs through. "Share port" asks for a host and a port, and the port is
then reachable as though the service were running here.

Two directions are available under "More options". The default sends a port on
the remote to this machine, which is what a remote dev server, database, or
debugger needs. The other sends a port here to the remote, for a webhook or an
agent on that host calling back. A row always names the side that listens first,
so which way a tunnel runs is never left to be inferred.

A shared port answers only on the machine that binds it, unless you tick "Share
on my network" — which re-exports the service to whatever network that machine is
attached to, and is marked `LAN` on the row so it cannot be forgotten about. A
port sent to the remote is bound on loopback there by default; widening it also
needs `GatewayPorts` enabled in that host's `sshd_config`, and the row says so
when the server refuses.

Each tunnel is a separate `ssh` process, which is what makes closing one exact:
the cross stops that tunnel and nothing else. It also means a host that
authenticates with a password asks once per tunnel, in the panel, and nothing
typed there is stored. Hosts using a key or an agent are not asked at all.

Shared ports are remembered between launches and come back listed but not
connected. Clicking one reconnects it — the app never opens a connection to a
host on its own at startup.

## AI command suggestions

Set an endpoint in Settings under "AI & voice": a base URL ending in `/v1`, a
model, and a key if the endpoint wants one. One field serves every provider,
because `chat/completions` is the request shape they all implement — a local
Ollama at `http://127.0.0.1:11434/v1` needs no key at all. "Test connection"
asks the model for a token and reports what came back, and "Refresh" lists the
models the endpoint says it has. A key is stored encrypted by the operating
system, never in the settings file, and is only ever read in the main process:
it is not held in the window.

Suggest asks what you want, then returns a single command with an explanation.
Only one command, ever — a reply naming several, or answering in prose rather
than the structure asked for, produces no command to run and says so. The
command is written to the pane you asked from, not to whichever pane is focused
when the answer arrives.

By default the model is told only your shell, directory and host. Turning on
"Send recent terminal output" also sends the tail of the focused pane, which is
what lets a suggestion read the error you are actually looking at — and means
terminal content goes to whatever endpoint you configured. The panel says which
of those is happening.

While output is being sent, approval cannot be turned off. Terminal output can
come from a remote host, and a host can print text shaped like an instruction;
a command chosen downstream of that must be read before it runs. The output is
sent as clearly delimited data with the delimiter stripped out of it, and the
answer is only believed if it arrives in the exact structure requested — but
neither of those is trusted to hold on its own, which is why the approval step
is not optional in that configuration.

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

Select files with a click, or several with Ctrl-click or Shift-click, then Upload or Download.
Double-click a folder to open it, or type a path into the folder box. New folder,
rename, and delete act on one selected item; deleting asks first, and a folder
must be empty, so a single click can never remove a tree. Remote folders can be
downloaded recursively with the system `sftp` client; uploads remain file-only,
so a local folder is never copied accidentally as a different job.

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

**Server** posts the recorded audio as a WAV file to a transcription server,
using the OpenAI `/v1/audio/transcriptions` shape that whisper.cpp's server, LM
Studio, faster-whisper-server and similar tools speak. This is the way to use a
model the built-in engine cannot load — a GGUF build such as
`unslothai/Qwen3-ASR-0.6B-GGUF` needs a llama.cpp-family runtime, so something
else has to host it. Any `http://` or `https://` address works: loopback, a
machine on the LAN such as `http://10.0.10.46:8888/v1/audio/transcriptions`, or
a hosted service. The field says whether the address it holds is on this machine
or not, because a remote one means recorded speech leaves it.

Servers that want authentication take an API key in the same panel, sent as an
`Authorization: Bearer` header. The key is not kept in the settings file: the
main process stores it encrypted through the operating system's own secret store
— DPAPI on Windows, Keychain on macOS, libsecret or kwallet on Linux — and hands
it to the renderer only for the request being made. On a system with no keyring
available, saving is refused rather than written in the clear, and the key can be
held for the session instead. Leave it empty for a local server that wants none.

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
