# Security Policy

## Supported versions

ZeroG Terminal is currently an alpha project. Security fixes are applied to the `main` branch and to the latest published release, when releases exist.

## Reporting a vulnerability

Please do not open a public issue for an exploitable vulnerability.

Use GitHub's private vulnerability reporting or security advisory feature for the `HappyMonkeyAI/ZeroGTerm` repository. Include:

- A clear description of the vulnerability and its impact.
- A minimal reproduction or proof of concept that does not expose real credentials.
- Affected versions or commits.
- Any suggested mitigation.

If private vulnerability reporting is unavailable, contact the repository maintainers through their GitHub account before disclosing the issue publicly.

Please allow maintainers reasonable time to investigate and prepare a fix. Do not include API keys, passwords, private SSH material, or sensitive user data in reports.

## Security boundaries

ZeroG Terminal is a local desktop application. Terminal output, SSH targets, generated commands, and workspace data should be treated as sensitive. The application is designed to:

- Keep Node integration disabled in the renderer.
- Keep context isolation and sandboxing enabled.
- Expose only a narrow preload API.
- Validate session names and SSH targets.
- Use argument arrays instead of shell interpolation.
- Require explicit approval before running AI-suggested commands, unless the
  operator turns that off in Settings.
- Refuse OSC 52 clipboard *read* requests, so a program in a terminal — including
  one on a remote host over SSH — cannot exfiltrate the clipboard. Clipboard
  writes from a terminal are honoured.

## Links in terminal output

A link clicked in a pane is opened in the user's own browser, never in a window
of this application. Electron's default answer to `window.open` is a new
`BrowserWindow`, which is both the wrong browser and a page rendered inside the
app; the main process refuses that and hands the URL to the desktop instead.

Which URLs are handed over is an allowlist — `http`, `https`, and `mailto`:

- A link arrives in terminal output, which is untrusted, and OSC 8 hyperlinks let
  a remote host display one thing while linking to another.
- The operating system will do much more with a URL than open a web page.
  `file:` reaches the local disk, `smb:` reaches a network share and leaks
  credentials to it, and installed applications register their own schemes, some
  of which accept a path or a command. A single click must not be able to start
  local software.
- The scheme is decided by parsing the URL rather than by matching its text, and
  the parsed form is what reaches the shell. A refused link reports itself in the
  status bar rather than failing silently.

Because the target of an OSC 8 link need not resemble its label, hovering a link
shows the real destination in the status bar before it is clicked.

## File transfer

The SFTP transfer panel widens the preload API to the local filesystem, which is
the narrowest part of the application worth stating plainly:

- The renderer can enumerate directories and can create, rename, or delete a path
  the user pointed at. It cannot read file *contents*: transfers are performed by
  the `sftp` client in the main process, and file data never passes through the
  renderer.
- Paths crossing the IPC boundary are re-derived in the main process rather than
  trusted. A relative path or one containing NUL is refused, and the home
  directory itself cannot be deleted.
- Deletion uses `rmdir` for directories, so a non-empty directory fails rather
  than being removed recursively.
- Remote paths containing quotes, backslashes, or glob metacharacters are refused.
  The `sftp` client unescapes its arguments and then expands globs in them, and no
  encoding of those characters is correct for every command — so a name that
  cannot be passed unambiguously is not passed at all.
- Authentication is delegated entirely to the system `sftp` client, which means
  `~/.ssh/config`, the agent, and `known_hosts` verification all apply. ZeroG
  never answers a host-key prompt itself: the question, including the key
  fingerprint, is put to the user. Passwords and passphrases are written to the
  client and are not stored, logged, or returned to the renderer.

## Network egress from the renderer

The renderer's Content-Security-Policy limits `connect-src` to:

- `'self'`, for the app's own assets.
- Any `http:` or `https:` origin, for two things: downloading speech models from
  Hugging Face on first use, and the server speech engine, whose endpoint is
  operator-configurable and may legitimately be a machine on the LAN or a hosted
  service. Nothing narrower can express "the host the operator chose".

The speech server endpoint is therefore a place where recorded audio goes where
the operator says, including off this machine. What is enforced is only the shape
of the target: an `http://` or `https://` URL naming a host, so a `file://` path
or a half-typed address becomes an error rather than a request. Where the audio
goes is the operator's decision, and the settings panel states plainly whether
the configured address is on this machine or not.

`style-src` allows `'unsafe-inline'`, which analysers flag on sight. It is there
for xterm.js: its DOM renderer creates two `<style>` elements at runtime — one
for the theme, one for cell dimensions — and writes their text directly, which
`style-src` blocks without it. xterm exposes no way to nonce those elements, so
the alternatives are `'unsafe-hashes'` over their exact contents or patching
xterm. React's `style` props are unaffected (they go through the CSSOM, which
CSP does not govern) and the bundled stylesheet is a linked file covered by
`'self'`, so xterm is the only reason the allowance is still needed. Removing it
would take a runtime policy from the main process rather than this static meta
tag, which would also let `connect-src` narrow back to the configured endpoint.

Earlier releases refused a non-loopback endpoint outright. That was relaxed
deliberately, on the grounds that a self-hosted server on the user's own network
is a normal way to run a model too large for the machine at hand. The trade is
that `connect-src` no longer constrains where the renderer can post, so an
injection in the renderer would not be stopped by the policy; the controls that
matter for that are the sandboxed renderer, context isolation, and the narrow
preload API described above.

## The speech server API key

A server that authenticates needs a key, and the renderer's own settings live in
localStorage — a plain file. So the key is not kept there:

- The main process stores it through Electron's `safeStorage`, which is DPAPI on
  Windows, Keychain on macOS, and libsecret or kwallet on Linux. The ciphertext
  goes in `secrets.json` under the app's data directory, written 0600 and
  replaced atomically.
- When `safeStorage` reports that encryption is unavailable — a Linux box with no
  keyring configured — saving is refused rather than downgraded to plaintext. The
  panel says so and offers to hold the key in memory until the app closes, which
  is the user's decision to make with the facts in front of them.
- A stored value that will not decrypt is treated as absent. That is what a file
  copied from another machine or another user account looks like, and there is
  nothing to do with it but ask for the key again.
- The renderer never holds the key in its own state or storage. It asks for it
  when a transcription request is being built and uses it for that request, so
  clearing the key takes effect on the next utterance.
- The key is sent as `Authorization: Bearer`. Over plain `http` to a host that is
  not this machine it travels in the clear; that is allowed, because a
  self-hosted server on the LAN commonly has no certificate and refusing would
  break the ordinary case, but the field says plainly when it applies.

These controls are not a guarantee of security. Please report bypasses or regressions privately.
