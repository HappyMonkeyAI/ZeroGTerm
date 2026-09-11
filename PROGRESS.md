# ZeroGTerm Progress

## Current status

The local MCP control surface is implemented on `feat/mcp-control` and pushed to `origin/feat/mcp-control`.

The selected execution model is interactive-pane execution. MCP commands run in the existing local shell only after explicit renderer approval. ZeroGTerm does not infer command completion from shell prompts or terminal output; timeout is the authoritative upper bound.

## Delivered

- Loopback-only, bearer-authenticated MCP server.
- Single-client renewable MCP control lease with capability checks and revocation.
- Workspace and session inspection, restoration, project workspace creation, and durable project-directory restoration.
- Renderer MCP settings and memory-only token handling.
- `session:execute` capability with bounded command validation.
- Explicit renderer approval for every command.
- Local-session-only PTY execution; SSH execution and credential automation remain disabled.
- Shell-operator, multiline, control-character, ANSI, credential-like, and remote-command rejection.
- Sensitive prompt classification and fail-closed handling for passwords, passphrases, verification codes, host-key prompts, and uncertain prompts.
- Bounded output capture at 16 KiB.
- Timeout, cancellation, takeover, and lease-revocation cleanup.
- PTY interrupt on cancellation, timeout, and output-limit exhaustion.
- Bounded in-memory MCP audit records with hashed client identifiers and truncated command previews.
- MCP documentation and lifecycle regression tests.

## Verification

Latest verified results:

- Full test suite: 959 passed, 1 skipped.
- Focused MCP lifecycle tests: 17 passed.
- Typecheck passed.
- Production build passed.
- `git diff --check` passed.
- Working tree clean at the last update.

## Key commits

- `2e25272` MCP control foundation
- `9515e67` durable MCP project workspaces
- `9b2a4fc` guarded MCP execution policy foundation
- `113ac97` MCP command approval requests
- `0eb4020` command approval controls
- `d9aebb4` sensitive-prompt fail-closed handling
- `5979cc5` bounded MCP execution results
- `dd1497d` cancellation and audit foundation
- `ff05866` audit state transitions
- `be46a13` cancellation and output-limit tests
- `de204d9` interactive execution model documentation

## Deliberate limitations

Reliable per-command exit status is not available when driving an interactive PTY. Adding it would require a supervised child-process execution model, which would no longer preserve the current pane shell context. The current design therefore remains timeout-bounded and fail-closed.
