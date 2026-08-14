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

## Network egress from the renderer

The renderer's Content-Security-Policy limits `connect-src` to:

- Hugging Face hosts, for downloading speech models on first use. Model weights
  are served from a regional CDN under `hf.co`, so those subdomains are allowed
  as well as `huggingface.co` itself.
- Loopback addresses (`127.0.0.1` and `localhost`), for the optional
  local-server speech engine. IPv6 literals are absent because Chromium rejects
  them as CSP host-sources; the endpoint validator refuses `[::1]` for the same
  reason rather than letting a URL pass and then be blocked silently.

The speech server endpoint is operator-configurable, which makes it a place
where recorded audio could be sent somewhere unintended. The URL is therefore
validated as loopback before any request is made, and a non-loopback address is
refused rather than sent — the CSP is a second line rather than the only one.
Anything that widens either control is a change worth reviewing carefully.

These controls are not a guarantee of security. Please report bypasses or regressions privately.
