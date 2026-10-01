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

## Hook run (2026-10-01, `npm run proto:pane-link-hook`, claude 2.1.286): YES, promising
- A per-pane `Stop` hook injected with `--settings` fired once per turn for both panes with no hand-edited settings.
- Payload carries `last_assistant_message`: exact final text, markdown and blank lines intact, no ANSI, no scrape noise.
- Turn-end is exact: relays landed only after the hook fired, so no stacking into a busy pane.
- Pane identity came from env (`ZEROG_PANE_ID`, `ZEROG_HOOK_DIR`) and an append-only events.jsonl, picked up by polling.
- Still to confirm: a turn that ends after tool calls (pane b ran tools in its third turn; check the final event in hook-run.log).

---

# Prototype 2: Stop-hook TurnSource (`npm run proto:pane-link-hook`)

## Question
Does a Claude Code `Stop` hook, injected per pane with `--settings` (no hand-editing of user settings), give ZeroG a
reliable turn-end signal and the exact final reply text, so panes can be relayed A to B to A?

## Verdict (run 2026-10-01, claude 2.1.286): YES.

- 4 of 4 turns relayed cleanly. Each Stop event carried `last_assistant_message` as the exact reply text: no ANSI, no
  spinner, no echoed prompt. Forwarded text was byte-for-byte what the agent wrote.
- Turn end is exact. The relay sent only after the hook fired, so there was no stacking into a busy pane, and
  latency tracked the model (about 4 s to 25 s) instead of a guessed quiet window.
- **Per-pane identity via env var works:** `ZEROG_PANE_ID` set on the pty was visible to the hook command, so one
  shared hook script tells the panes apart. The sink wrote one JSONL line per event to a directory ZeroG owns.
- **`--settings` injection works** with inline JSON using the nested schema
  `{hooks:{Stop:[{hooks:[{type:'command',command:'node "<abs path>"'}]}]}}`. Nothing in user or project settings was
  edited. (A docs lookup claimed `--settings` replaces rather than merges hook arrays; not tested here, so
  whether a user's own Stop hooks still run alongside ours is an open question.)
- Stop payload fields seen: session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name,
  stop_hook_active, last_assistant_message, background_tasks, session_crons.
- Observation: the agents did not obey "do not use any tools" and read repo files (the cwd was this repo), which made
  one turn slow. A linked pane is a normal agent with normal tool access, and the relay must not assume otherwise.

## Still open (not answered by this prototype)
1. **Agent coverage:** only Claude Code was tested. Codex, Gemini CLI, etc. need their own TurnSource or fall back to
   the weak quiet-timer hint.
2. **Permission prompts mid-turn:** Stop does not fire while the agent waits for approval, so a link would just sit
   idle. Needs the `Notification` hook (or the prompt classifier) to pause the link and tell the user.
3. **Interrupts / API errors:** Stop does not fire on Esc interrupt; `StopFailure` covers API errors. The controller
   needs a timeout and a user-visible "stalled" state.
4. **Hook-merge behaviour** with the user's existing Stop hooks (see above).
5. **Productising the injection:** ZeroG would launch the agent itself with `--settings`, or the user runs plain
   `claude` in a pane and ZeroG cannot inject. Decide: a "start linked agent" action vs. a documented hook snippet.
6. **Windows quoting** worked for `node "<path>"`; Linux and over-SSH panes (hook runs on the remote host, so the
   sink would need a channel back) are untested. SSH panes are the hard case.
7. The relay inserted text via bracketed paste + Enter and it landed as a single prompt every time.
