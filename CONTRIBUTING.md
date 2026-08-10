# Contributing to ZeroG Terminal

Thanks for your interest in ZeroG Terminal. The project is an early Linux-first Electron terminal workspace, so focused bug reports, reliability improvements, and small, well-tested changes are especially useful.

## Before opening an issue

- Search existing issues first.
- Include the ZeroG Terminal version or commit when known.
- Include the host distribution, desktop session (Wayland/X11), Node.js version, and whether `screen` is installed.
- Do not include credentials, private SSH details, terminal output containing secrets, or personal filesystem paths.

## Development setup

Requirements:

- Node.js 22 or newer
- npm
- A C/C++ toolchain for `node-pty`
- `screen` for persistent local sessions (optional; ZeroG has a process-only fallback)

```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

For full local-session behavior on Fedora:

```bash
sudo dnf install screen make gcc-c++ python3
```

Without `screen`, local terminals use a direct `bash` PTY and are explicitly non-persistent. They do not survive application exit or relaunch.

## Making changes

1. Create a branch from `main`.
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
