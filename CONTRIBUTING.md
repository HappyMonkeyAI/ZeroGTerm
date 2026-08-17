# Contributing to ZeroG Terminal

Thanks for your interest in ZeroG Terminal. The project is an early Electron terminal workspace, developed Linux-first and also running on Windows, so focused bug reports, reliability improvements, and small, well-tested changes are especially useful.

## Before opening an issue

- Search existing issues first.
- Include the ZeroG Terminal version or commit when known.
- Include the operating system, the Node.js version, and whether `screen` is installed. On Linux, add the distribution and whether the desktop session is Wayland or X11; on Windows, the shell backend the session was using.
- Do not include credentials, private SSH details, terminal output containing secrets, or personal filesystem paths.

## Development setup

Requirements:

- Node.js 22 or newer
- npm
- A C/C++ toolchain for `node-pty`, on Linux only — it ships prebuilt binaries for Windows and macOS
- `screen` for persistent local sessions (Linux and macOS only; optional, ZeroG has a process-only fallback)

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

These run on Linux and Windows. npm runs package scripts through `cmd.exe` on
Windows, so no POSIX shell is needed whichever shell you start them from.

For full local-session behavior on Fedora:

```bash
sudo dnf install screen make gcc-c++ python3
```

Without `screen`, local terminals use a direct PTY on the selected shell and are
explicitly non-persistent: they do not survive application exit or relaunch. That
is always the case on Windows, where `screen` does not exist — a Windows change
touching session persistence should be checked against that path rather than the
`screen` one.

## Making changes

1. Create a branch from `dev` and open the pull request against `dev`. `dev` is
   the integration branch; `main` receives work through a periodic `dev` to
   `main` pull request, not directly.
2. Keep changes focused and avoid committing generated output, `node_modules`, credentials, or `.env` files.
3. Add or update tests for behavior changes.
4. Run the verification commands before opening a pull request:

   ```bash
   npm run typecheck
   npm test
   npm run build
   npm audit --audit-level=high
   ```

5. Explain the user-visible behavior and verification performed in the pull request description.

## Code conventions

- Keep Electron security boundaries intact: context isolation enabled, Node integration disabled, sandboxed renderer, and narrow preload APIs.
- Use argument arrays for external commands; never construct shell commands by interpolation.
- Keep persistence state explicit. Do not silently replace a persistent session with a process-only shell.
- Preserve keyboard-accessible and mouse-equivalent controls.
- Do not add secrets or private service endpoints to source, tests, documentation, or fixtures.

## Pull requests

Pull requests should describe:

- What changed and why.
- Any compatibility or persistence implications.
- Tests, builds, audits, and runtime smoke checks performed.
- Follow-up work that is intentionally out of scope.

By contributing, you agree that your contributions may be distributed under the MIT License in this repository.
