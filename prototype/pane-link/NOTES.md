# Pane link prototype - THROWAWAY (delete or absorb before merge)

Run: `PROTO_CWD=<trusted dir> CLAUDE_BIN=<full path to claude.exe> npm run proto:pane-link`
(`q` breaks the link; log goes to `run.log`, transcript to `transcript.json`; both are gitignored.)

## Question
Can the "other agent's reply" be recovered from a raw PTY stream with only an output-quiet timer
(3 s quiet, 4 s minimum wait), relaying A to B to A, using two real `claude` TUIs under node-pty?

## Verdict (run 2026-10-01, Windows, claude 2.1.286): NO, not usable as the real mechanism.

1. **Turn end fires too early.** Turn 1 was declared finished while Claude still showed "Waddling..." (thinking). The
   spinner and the model latency leave gaps longer than the quiet window, and the real answer arrived afterwards.
2. **The captured "reply" is screen scrape, not a reply.** It was the echoed prompt, box-drawing borders, spinner
   glyph soup, "[Pasted text #1 +5 lines]", and redraw fragments. Spaces vanish because the TUI positions text with
   cursor-move sequences. Nothing in the stream says which part is the answer.
3. **Relaying into a busy pane stacks input.** Because (1) fired early, text was pasted into a pane that was still
   working, and each later relay grew (1.5k, 3.1k, 6.1k chars) as garbage was echoed back and forth.
4. **Trust dialog / readiness is its own problem.** A fresh directory shows a trust dialog that ignored a bare Enter; a
   loose "ready" regex made the seed land in the dialog and both agents exited 1. Readiness must come from the
   real prompt hint ("? for shortcuts"), and the link should refuse to start unless both panes are at that prompt.
5. **Repo gap found:** `src/shared/ansi.ts` CSI pattern does not match private-parameter sequences such as `ESC[>4m`
   (`>`, `<`, `=` parameter bytes). Worth fixing independently.
6. Bracketed paste (`ESC[200~ ... ESC[201~` then Enter) did deliver multi-line text as one prompt.

## What this means for the plan
- Option 2 (quiet timer) is only good as a *hint*; promote the hook-based TurnSource (option 1: Claude Code `Stop`
  hook giving the exact final message text) to the primary path, with MCP (option 3) as the alternative.
- Keep from here: `relay.mjs` state machine shape (cap, break, one-send-per-turn), bracketed-paste delivery, framing
  prefix, and the "only send when target is at its prompt" rule.
- Next prototype question: does a `Stop` hook reliably give the final assistant text and a turn-end signal that
  ZeroG can pick up (file watch or private OSC), per pane, without the user hand-editing settings?
