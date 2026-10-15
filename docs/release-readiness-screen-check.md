# v1 release evaluation

Date: 2026-10-15. Verification below was performed against `0.9.4-alpha.1`. The verified source is now prepared as `1.0.0`; the older artifact names and hashes below remain historical evaluation evidence. Build fresh 1.0.0 artifacts from the release commit before publication. No tag or publication was performed.

## Outcome

The investigated build, installer, shutdown, recovery and dependency-audit gates now pass. The candidate is ready for v1 release-candidate review. Four local desktop artifacts and checksums are in ignored `dist/`; evidence is retained under ignored `.release-check/`. Windows signing and final product acceptance remain release-owner decisions.

## Repairs

- Remote screen discovery follows the selected SSH destination, including manually entered hosts. Account, custom port and aliases survive discovery and attachment; refresh/errors are visible and stale results are discarded. Attachment runs screen directly through SSH with validated names and main-owned metadata. `TERM=xterm-256color` fixes Windows OpenSSH terminal compatibility.
- Restored SSH panes wait for an explicit reconnect. Same-named screen reuse is scoped to session kind and destination. A real server session retained an exported variable across full application shutdown and reconnect.
- The pinned node-pty 1.1.0 patch enumerates console processes before native console closure and skips enumeration after a known native exit. It is idempotent, checks the dependency version/source shape, and runs during install/build. Dependency resolution supports both hoisted and nested npm layouts, with regression tests. The experimental bundled ConPTY backend was rejected because its diagnostic runner hung.
- Terminal, SFTP and tunnel PTYs share shutdown tracking. Electron waits for exit callbacks with a six-second bound, refuses new PTYs during quit and reports timeouts. Delayed exit events from replaced attachments cannot remove their replacements.
- Package whitelists exclude previous installers and unpacked releases, eliminating recursive artifact bundling. The npm launcher diagnoses a missing Electron runtime and documents installing it explicitly.
- Windows Build Tools now includes the matching MSVC 14.44.35207 Spectre libraries. `.vsconfig` and `scripts/ensure-windows-build-tools.ps1` make the prerequisite reproducible; release CI checks it before dependency installation. The normal native rebuild succeeds without disabling mitigations or using `npmRebuild=false`.
- Clean Debian installation exposed a missing audio runtime dependency. The package now explicitly declares `libasound2` and `libgbm1` alongside its other Electron dependencies. Linux packaging installs to `/opt/ZeroGTerminal`, avoiding the upstream [Electron sandbox launcher issue with spaces in install paths](https://github.com/electron/electron/issues/44414), while preserving the visible application name.

## Moderate advisories

The eight npm findings shared one root: [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), affecting `sprintf-js` through electron-builder → app-builder-lib → @electron/get 3.1.0 → global-agent 3 → roarr. Untrusted format precision can throw a RangeError; the advisory offers no patched sprintf-js release.

A scoped override selects `global-agent` 4.1.3 only for @electron/get 3.1.0. This removes roarr/sprintf-js and their obsolete dependencies without downgrading electron-builder. The [global-agent releases](https://github.com/gajus/global-agent/releases) retain the CommonJS bootstrap API. A dedicated fixture exercises the actual builder downloader's proxy initialization, routing through a local proxy and bypassing it with `NO_PROXY`, on Windows and Linux. Both full dependency audits report **zero vulnerabilities**. Release CI enforces the proxy check and moderate-level audit.

## Verification

| Check | Evidence |
| --- | --- |
| Windows tests | 64 files; 1,169 passed, 3 platform skips. Typecheck and build pass. |
| Linux tests | 64 files; all 1,172 passed, including live local-screen lifecycle. Typecheck and build pass in isolated WSL Ubuntu source/dependencies. |
| Shutdown | Real Windows forced-kill and natural-parent-exit checks pass after native packaging; descendant PIDs are gone and no AttachConsole warning occurs. Unit tests cover ordering, known exit, duplicate kills, waiting, timeout and replacement ownership. |
| Windows native packaging | Normal `npm run package:win` succeeds with native rebuild. Installer and portable artifacts exclude nested releases; native addon and packaged teardown patch were inspected. |
| Windows install/reinstall/uninstall | Actual current-user silent installer succeeds in an owned test directory; normal native candidate reinstalls successfully. Installed app passes runtime smoke. Uninstaller removes executable and registration. Six existing default-profile JSON files retain their hashes, isolated profile sentinel survives, and the pre-existing custom Start-menu shortcut is restored byte-for-byte. Test installation removed. |
| Windows runtime | Installed native candidate creates a real PowerShell pane, persists settings, handles synthetic microphone/server transcription and AI endpoint fixtures. Unpacked and portable runtime checks also pass. |
| Remote workflow | On user-selected `192.168.5.215`: discover/attach/restart/reconnect with surviving screen variable; SFTP mkdir/upload/list/download/content comparison/rename/remove; forward and reverse SSH tunnels. Owned remote fixtures cleaned. Final native candidate repeats the remote smoke successfully. |
| Linux installed runtime | Real Debian installation in WSL Ubuntu runs with sandbox enabled under Xvfb. Terminal, settings, synthetic voice/AI and automatic local-screen recovery after full restart pass. Remove/purge eliminates binary, alternative and desktop entry; isolated profile evidence remains. |
| Fresh Debian lifecycle | Clean Debian container installs final package with `--no-install-recommends`; audio/graphics dependencies resolve and `ldd` reports no missing libraries. Install/remove/purge preserves user-data sentinel. Reinstallation migrates old spaced install path to new path successfully. Owned test containers removed. Docker's namespace restrictions preclude sandboxed GUI there; installed GUI evidence comes from WSL instead. |
| AppImage | Actual AppImage runtime passed local terminal, settings, synthetic voice/AI and persistent local-screen recovery with sandbox enabled, using extraction mode rather than FUSE. |
| Built-in voice | Packaged Windows Whisper tiny.en q8 WASM loads its normal model and transcribes generated speech as “Zero Gravity Terminal Release Check.” First-load inference about 22 seconds. |
| npm lifecycle | Fresh isolated prefix install with Electron 43, actual packaged application launch and removal pass. Found and fixed hoisted dependency lookup during this check. Electron downloads its executable on first resolution. Recent npm script-approval policy required explicitly approving dependency installation scripts in the disposable prefix. No global user npm install changed. |
| Audit/proxy | Full Windows and Linux audits: zero vulnerabilities. Actual downloader proxy and NO_PROXY fixture passes on both platforms. |
| Hygiene/workflows | `git diff --check` and actionlint pass. Existing unrelated changes/untracked files preserved. |

## Reproduction

- `npm run typecheck`, `npm test -- --reporter=dot`, `npm run build`.
- Windows prerequisite: `powershell -ExecutionPolicy Bypass -File scripts/ensure-windows-build-tools.ps1`; then `npm run package:win` and `node scripts/pty-shutdown-smoke.cjs`.
- Linux: `ZEROG_LIVE_SCREEN=1 npm test`; `npm run package:linux`.
- `node scripts/check-downloader-proxy.mjs`; `npm audit --audit-level=moderate`.
- `node scripts/release-smoke.mjs <executable> <isolated-profile> [ssh-target]`. `ZEROG_SMOKE_APP_ROOT` selects an installed npm application directory. Optional `ZEROG_SMOKE_BUILTIN_AUDIO=<generated-wav>` adds actual built-in inference.

The smoke uses synthetic capture devices and local endpoint fixtures. This verifies application mechanics; physical microphone quality and particular third-party AI services still need operator acceptance. Password-only background discovery remains unsupported because it uses a separate noninteractive SSH connection; attachment retains interactive authentication prompts.

## Artifacts and remaining release decisions

| Artifact | Bytes |
| --- | ---: |
| ZeroGTerminal-0.9.4-alpha.1-Setup.exe | 236,819,317 |
| ZeroGTerminal-0.9.4-alpha.1-Portable.exe | 236,589,217 |
| ZeroGTerminal-0.9.4-alpha.1-x86_64.AppImage | 461,910,761 |
| ZeroGTerminal-0.9.4-alpha.1-amd64.deb | 365,641,228 |

`dist/SHA256SUMS` and `.release-check/artifacts.json` record SHA256 hashes. Windows binaries remain unsigned; the default Electron icon, package sizes and Vite chunk warning remain polish considerations. No unresolved installer/build/audit failure remains in these checks.

Windows lifecycle evidence: `.release-check/windows-installer/lifecycle.json`; final native remote runtime: `.release-check/native-final-remote/results.json`; npm runtime: `.release-check/npm-runtime-complete/results.json`; Debian logs: `.release-check/debian-lifecycle/`. Linux test/runtime/install/removal logs remain in isolated WSL source `/tmp/zerog-release-20261015-0948` and `/tmp/zerog-wsl-*.log`. No test app remains installed in Windows or WSL.
