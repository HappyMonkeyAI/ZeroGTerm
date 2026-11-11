# Release notes

## 1.1.0 — 2026-11-11

ZeroG Terminal 1.1 tells you when a new release ships and, on the Windows installer and AppImage, can install it for you. It also reopens recent sessions at startup, adds favourite directories, and lets you close a terminal from the sidebar.

### New

- **Update notifications.** A few seconds after launch ZeroG checks for a newer release and shows a popup. The Windows installer and AppImage can **Download & install** and then **Restart & install**; the portable `.exe` and `.deb` link to the release page. Nothing downloads until you choose to. **Later**, **Skip this version**, and the startup check are controlled in **Settings → Updates**. This release is the first to carry the updater, so 1.0.0 users need to install it by hand once.
- **Recent sessions at startup.** A launch picker offers up to eight recently open sessions; screen sessions reattach, and local shells can reopen in their last directory with the opt-in **Remember directories** setting.
- **Favourite directories.** Star a pane's directory from the path line and jump back to it from the favourites menu, in the same pane or a new one.
- **Close from the sidebar.** Hovering a terminal card in a workspace shows a × that closes the pane, the same as the pane's own close button.
- **Open in a directory.** `--cwd`, `ZEROG_OPEN_CWD` or a bare path opens a local shell there; a second launch opens it in the running window.

### Fixes

- Local PowerShell, pwsh and cmd panes follow `cd`, so the breadcrumb, directory browser and picker stay in step. The PowerShell integration snippet's malformed OSC 7 path is fixed.
- New local terminals open in the shell chosen (pwsh, cmd, fish and sh previously fell back to the default).
- Built-in voice input transcribes recordings longer than 30 seconds, in overlapping chunks; the limit rises to 300 seconds, default 120.
- Dependency updates clear every npm audit advisory, including Electron 43.8.7 and an override for the vulnerable `minimatch` in the packaging toolchain.

### Known limits

Windows binaries remain unsigned, so SmartScreen may warn when the installer or an update runs. Local Windows shells are process-only; persistence requires Linux or a remote host with screen.

## 1.0.0 — 2026-10-15

ZeroG Terminal's first stable release brings persistent terminal and SSH workspaces to Windows and Linux, with pane layouts, SFTP transfers, SSH port sharing, configurable AI and voice input, and optional supervised local MCP control.

### Reliability

- Discover running remote screen sessions for the selected SSH destination, including manually entered hosts, with refresh and visible errors.
- Reconnect directly to existing screens while preserving SSH accounts, ports and aliases. Restored SSH panes reconnect on request; local Linux screens restore automatically.
- Preserve remote shell state across application restarts and prevent stale attachment events from closing replacement sessions.
- Coordinate terminal, SFTP and tunnel shutdown and fix Windows ConPTY teardown warnings and orphaned descendants.

### Installation and builds

- Prevent previous installers and unpacked releases from being bundled into new packages.
- Provide reproducible Windows C++/Spectre prerequisites and verify normal native builds.
- Declare missing Debian audio/graphics dependencies and use a sandbox-compatible Linux installation path.
- Fix npm installation with hoisted dependencies and document the explicit Electron runtime requirement.
- Remove the moderate build-tool advisory dependency chain, with proxy compatibility checks and CI auditing.

### Verification and known limits

Windows tests: 1,169 passed, 3 platform skips. Linux tests: all 1,172 passed. Typechecks, builds, install/reinstall/removal, SSH screen recovery, SFTP and both tunnel directions passed. Full dependency audits report zero vulnerabilities. See [the evaluation report](docs/release-readiness-screen-check.md) for evidence and scope.

Windows binaries remain unsigned. Local Windows shells are process-only; persistence requires Linux or a remote host with screen. Background SSH discovery requires key/agent authentication; interactive attachment supports authentication prompts. Voice and AI quality depend on the microphone, model and endpoint selected.
