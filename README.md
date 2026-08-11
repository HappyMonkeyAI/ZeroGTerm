# ZeroG Terminal

ZeroG Terminal is a Linux-first Electron workspace for persistent `screen` sessions. This first vertical slice includes:

- Electron security boundary: sandboxed renderer, context isolation, disabled Node integration, narrow typed preload API.
- Session sidebar with create, discover, refresh, and attach actions.
- Visible actions for opening a persistent local terminal and connecting to an SSH target (`host`, `user@host`, or `user@host:port`).
- xterm.js terminal renderer and a split workspace surface.
- Persistent dark/light theme with an accessible sun/moon toggle.
- Safe session-name validation and argument-array `screen` invocation.
- AI command approval surface; suggestions are visible and require explicit approval before being sent to the terminal.
- Voice input per pane: click the microphone, speak, and the utterance is transcribed locally with Whisper-tiny (via Transformers.js; the model is downloaded once on first use) and typed into the pane's prompt without auto-execution.

## Release status

ZeroG Terminal is currently a public alpha. The initial npm release is `0.1.0-alpha.1` and is configured for the `alpha` dist-tag. The version history is tracked in [versions.txt](versions.txt).

The npm package contains the built Electron application and project documentation. It is intended for early adopters and testing rather than production use.

## Terminal shortcuts

- `Ctrl+Shift+C` — copy selected terminal text
- `Ctrl+Shift+V` — paste into the active terminal
- `Ctrl+C` remains the interrupt signal (not copy)
- `Ctrl+Shift+N` — new workspace
- `Ctrl+Shift+T` — new local terminal in the current workspace
- `Ctrl+Shift+O` — session overview
- `Ctrl+Shift+B` — toggle sessions sidebar
- `Esc` — close overview / dialogs, cancel voice recording

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

After installing the published package, launch ZeroG Terminal with:

```bash
npx zerogterm
```

Runtime prerequisites on the host:

```bash
sudo dnf install screen make gcc-c++ python3
npm install node-pty
```

`node-pty` is required for terminal I/O. When `screen` is installed, local sessions are persistent and discoverable after relaunch. Without `screen`, ZeroG now falls back to a direct `bash` PTY and labels the session as process-only; that shell is lost when the application exits and the dependency warning remains visible. Install `screen` for full persistence:

```bash
sudo dnf install screen
```

## Current verification

- `npm run typecheck`: passes.
- `npm test`: passes (9 tests covering name validation, `screen -ls` parsing, SSH argument validation, session close semantics, and voice silence detection).
- `npm run build`: passes and writes `dist/main` plus `dist/renderer`.
- Electron is configured to disable hardware acceleration by default for the Fedora Toolbox/Wayland runtime; set `ZEROG_ENABLE_GPU=1` only when GPU launch is stable on the host.
- `npm audit --omit=dev`: reports no known production vulnerabilities.

The live screen + node-pty smoke test creates a temporary named session, writes a marker through the PTY, observes it, and cleans up the session.

## License

ZeroG Terminal is released under the MIT License. See [LICENSE](LICENSE).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, testing, and pull-request guidance. Please report security vulnerabilities privately through GitHub; see [SECURITY.md](SECURITY.md).
