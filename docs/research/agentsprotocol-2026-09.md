# AgentsProtocol update review

Date: 2026-09-14
Source: https://github.com/HappyMonkeyAI/AgentsProtocol

The current `main` tip is `d520b2b` (`docs: capture agent harness bookmark research`). The preceding update adds ADR-0004, an evidence-based adaptive model escalation policy. The newer research note recommends three bounded ideas: prefer deterministic structured interfaces over GUI automation when both work, distinguish repair from capability growth and evaluation, and keep model/tool/session integrations replaceable.

Adopted locally:

- `AGENTS.md` records the escalation, iteration labels, structured-interface preference, and verification rules.
- `MCP.md` provides a project-specific intent map without credentials.
- `docs/adr/0004-adaptive-model-escalation.md` adapts the policy to ZeroG's boundaries.

Not adopted:

- wholesale replacement of ZeroG's existing documentation or runtime;
- automatic commits, resets, credential handling, or autonomous destructive actions;
- Neo4j, OpenSandbox, DeepSeek Harness, or other new runtime dependencies;
- the unrelated `feature/agent-worktree-infrastructure` branch, which contains a different multiplayer application rather than protocol-only changes.
