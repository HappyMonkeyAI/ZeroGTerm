# v1 evaluation and shutdown repair plan

Preserve the existing screen-recovery diff. Reproduce node-pty warnings without the app; prove a focused repair eliminates the race, terminates descendants and lets the runner exit. Keep the current ConPTY backend: evaluating the experimental DLL backend left the runner hanging.

The affected boundary is the shared node-pty dependency used by terminals, SFTP and tunnels. A version-pinned, idempotent dependency patch must be applied on install and build and included in packaged assets. Verify deferred teardown ordering and late exit events before trusting live checks.

Then run tests/typecheck/build/audit, build Windows installer and portable assets without publication, inspect native packaging and run the packaged application. Exercise local terminals, screen recovery across an application relaunch, workspace/settings restoration, real SFTP roundtrip, and loopback-only forwarding. Use temporary owned fixtures on the already selected host; remove them afterwards. Evaluate AI and speech against bounded local fixtures; distinguish fixture contract evidence from live provider/microphone quality. Inspect Linux runtime availability; record genuine environmental blockers rather than claiming cross-platform sign-off.

Repair discovered during artifact inspection: broad dist globs admit previous installers/unpacked releases into subsequent packages. Restrict both npm and Electron package contents to compiled main/renderer assets; verify artifact file lists and rebuild candidates.


## Final installer, toolchain and advisory checks

User explicitly authorized install/uninstall tests, Windows prerequisites and moderate-advisory investigation. Add only the matching MSVC x86/x64 Spectre component, with no reboot or compiler-mitigation bypass. Validate the normal Windows native rebuild afterwards.

No ZeroG per-user or machine uninstall registration was found in the baseline. Windows Sandbox is unavailable. Test the real per-user installer in a dedicated workspace directory with a separate app profile; capture registry/shortcut baseline and readback, run the installed binary, then uninstall exactly that registration and verify cleanup plus profile preservation. Do not alter unrelated registrations or an existing default user profile. Use a disposable Docker Debian container for actual package installation/removal and desktop registration checks.

The moderate alerts originate in sprintf-js through the builder's proxy bootstrap dependency. Investigate the upstream advisory and use a narrowly scoped dependency override only if its public bootstrap API remains compatible; verify proxy routing and no-proxy behavior against a local fixture and rebuild both platforms. Do not suppress audit findings or apply a force downgrade.


Installer evidence revealed two Debian defects hidden by the existing desktop runtime: libasound was undeclared, and the spaced /opt/ZeroG Terminal path fails when Chromium uses its SUID sandbox helper (Electron issue 44414). Declare audio/GBM dependencies and use a space-free Linux product install directory while retaining the visible desktop name. Docker denies namespace creation even for a privileged exec, so use it for clean dependency/install/purge checks and use WSL with working namespaces for the actual installed-app sandboxed runtime. Check both root/user registrations before installing and purge only the test package afterwards.
