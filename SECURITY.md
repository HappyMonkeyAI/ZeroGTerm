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
- Require explicit approval before running AI-suggested commands.

These controls are not a guarantee of security. Please report bypasses or regressions privately.
