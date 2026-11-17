# ADR-0004: Evidence-based adaptive model escalation

## Status

Accepted

## Context

ZeroG supports AI-assisted development, but using the deepest reasoning mode for every task wastes resources while blindly retrying a shallow approach creates repair loops. AgentsProtocol's Pulse and Ripple practices provide a safer basis for choosing when to escalate.

## Decision

Use the least expensive reasoning depth adequate for the task. Routine, well-specified, single-file work stays at the baseline tier. Before retrying a failure, classify it as environmental/flaky, local implementation, or contract/cross-module. Diagnose environmental failures first, make one focused repair for local failures, and treat public-boundary or contract failures as escalation candidates.

Escalate one reasoning tier after two materially unsuccessful repair attempts, or earlier when dependency analysis finds a broad public boundary, weakly documented legacy code, or unexplained contract drift. The handoff must include acceptance criteria, changed paths/current diff, exact failing command and output, dependency map, and prior attempts. Give the escalated pass a bounded budget.

If escalation fails, stop and re-plan. Escalation never bypasses worktree isolation, approval requirements, or the verification ladder. It does not replace independent adversarial checks or live runtime evidence.

Iteration work is labelled `repair`, `capability growth`, or `evaluation`; repeated repair-only iterations trigger fresh diagnosis instead of more local patches.

## Consequences

This preserves fast routine work, makes escalation evidence-based and provider-neutral, and prevents model choice from being mistaken for acceptance proof. It adds a small classification and handoff cost.

## Related

- [AgentsProtocol](https://github.com/HappyMonkeyAI/AgentsProtocol)
- [docs/mcp.md](../mcp.md)
- [AGENTS.md](../../AGENTS.md)
