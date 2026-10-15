# Release notes

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
