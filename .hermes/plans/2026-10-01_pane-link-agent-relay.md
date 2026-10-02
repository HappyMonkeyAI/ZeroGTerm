# Pane Link (Agent-to-Agent Relay) Plan

> Status: IN PROGRESS on `feat/pane-link` (from `dev`). Phase 1 (two-way, Claude Code, local panes) is implemented; see `docs/pane-link.md` and `FEATURE-DEV.md`. Prototype findings: `2026-10-01_pane-link-prototype-findings.md`.

**Goal:** Let the user link two panes that each run an AI agent (e.g. `claude`) so that the finished reply in pane A is typed into pane B as its next prompt, B's finished reply is typed back into A, and so on until the user breaks the link. This replaces manual copy/paste between agent panes.

## Prior art: Clay (chadbyte/clay)

Clay is a browser workspace over the Claude Agent SDK / Codex app-server. Its multi-agent pieces are all **structured-protocol** features, not terminal scraping:

- **Mates**: persistent personas (own CLAUDE.md, knowledge, memory).
- **Debates**: panelists with "moderated turns"; a moderator picks the speaker.
- **Ralph Loop**: code, evaluate, retry until a `JUDGE.md` approves or the user caps the loop.
- **Paired sessions / spawned workers**: sessions share a UI.

The README documents no agent-to-agent message routing. Clay can hand turns around because it owns the SDK event stream, so "turn finished" and "final text" are exact. ZeroGTerm only sees a PTY byte stream from a TUI, so those two things must be inferred. Ideas worth borrowing: a **moderator/turn-order** concept, a **hard iteration cap**, and an optional **judge/stop condition**.

## Key difficulty

Detecting "agent finished its turn" and extracting "its reply" from a TUI. OSC 133 only brackets the launching command, not each agent turn (`src/renderer/command-capture.ts`). Options, best first:

1. **Agent-side hook.** Claude Code's `Stop` hook (and similar) can emit a signal, e.g. write the final assistant message to a file or emit a private OSC sequence ZeroG recognises. Exact turn end and clean text, but per-agent setup.
2. **Quiet timer.** Output idle for N ms, as `waitForShellPrompt` does (`main.tsx` ~2095-2125). Works with any TUI, but is fragile (long thinking pauses, spinners) and the captured text is screen-scraped.
3. **MCP route.** Each agent gets a ZeroG MCP tool such as `zerog_pane_reply`. Clean text and explicit turn end, but needs a new, tightly scoped tool; the existing safety rules forbid a generic write-to-PTY tool.

Recommendation: build the controller against an abstract `TurnSource` interface, ship option 2 first as a prototype to learn how bad it is, and make option 1 the intended real path.

## Design (renderer-side controller)

- New pure module `src/renderer/pane-link.ts`, modelled on `command-capture.ts`: takes the data stream, a writer and a clock; unit-testable with no Electron.
- Taps the per-chunk `onData` path (`main.tsx` ~1676), strips ANSI with `src/shared/ansi.ts`, delivers text with `api.write(sessionId, text + '\r')`. No new IPC needed for the prototype. Moving to main later would let links survive a closed renderer, but main has no terminal grid.
- State per link: `{ a, b, direction (one-way | two-way), turnsRemaining, state: idle | waitingA | waitingB | paused | broken }`.
- UI: link toggle in `pane-actions`, a visible "linked" indicator on both panes, one-click break, a pause/step mode, and an optional seed prompt.

## Safety (required by CONTEXT.md: no autonomous agent loops without explicit design and approval)

- User-initiated only; never auto-link.
- Visible indicator on both panes; break is always one click and also on Esc / pane close / session exit.
- Hard turn cap (default small, e.g. 10) and minimum delay between relays.
- Reuse `src/main/prompt-classifier.ts`: if a pane looks like a password / passphrase / OTP / host-key prompt, pause the link and never forward.
- Only forward when the target pane is idle at an agent prompt; never inject into a running turn.
- Cap forwarded payload size; strip control characters and escape sequences from forwarded text; frame it (e.g. prefix "Message from pane A:") so the receiving agent knows the source.
- Remote (SSH) panes: link allowed only between panes the user selected; no forwarding to a pane whose cwd/session changed.
- Prompt-injection note: relayed output is untrusted input to the other agent. Document this in `SECURITY.md`.

## Phases

1. **Prototype (throwaway, per `prototype` skill):** quiet-timer relay between two panes behind a setting flag; learn turn-detection reliability with real `claude` panes.
2. **Controller + tests:** `pane-link.ts` with fake clock and fake writer; `tests/pane-link.test.ts` covering turn cap, break, pause on secret prompt, re-entrancy, and both panes closing.
3. **UI:** toggle, indicator, break, turn counter, settings (cap, idle ms, framing prefix). `settings.ts` + `settings-panel.tsx` + `help-panel.tsx`.
4. **Agent-hook TurnSource** for Claude Code (`Stop` hook); document install snippet next to `shell-integration.ts`.
5. **Docs:** `FEATURE-DEV.md` section, `SECURITY.md`, ADR-style note on loop safety; pre-mortem before merge.
6. **Verification Ladder (ADR-0001):** typecheck, full tests, build, `npm audit`, and launch the app with two real agent panes on Windows and Linux.

## Decisions (confirmed by user 2026-10-01)

- **Order of delivery:** two-way ping-pong first, then one-way relay (A to B), then later N-way with a moderator.
- **Turn detection:** quiet-timer prototype first is acceptable; agent-hook TurnSource is the intended real path.
- **Forwarded payload:** the whole reply, not only the last block.
- **User injection mid-loop:** wanted, but may be deferred to a later iteration if it complicates the controller.

## Roadmap

1. Two-way ping-pong link (this branch).
2. One-way relay: A's replies feed B; B's replies are not sent back. Same controller, `direction: 'one-way'`.
3. User message injection mid-loop (pause, type, resume) if not cheap in step 1.
4. Agent-hook / MCP TurnSource for exact turn ends and clean reply text.
5. N-way links with a moderator pane or turn order (Clay-style debate), optional judge/stop condition (Clay-style Ralph Loop).
