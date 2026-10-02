# Pane link

Pane link relays one AI agent's finished reply into another agent's prompt, and the
answer back, until you break the link or the relay limit is reached. It replaces
copying a reply from one agent pane and pasting it into another.

## Using it

1. In each of two local panes, click the link button in the pane header
   (**Start a linked agent**). ZeroG types your AI command (Settings, default
   `claude`) with `--settings "<file>"` appended and presses Enter. The file points
   the agent's hooks at ZeroG; nothing in your own Claude settings is edited.
2. In either pane, click the link button again and choose **Link with ...**.
3. Prompt either agent as normal. When its turn finishes, the whole reply is typed
   into the other pane as a prompt, and so on back and forth.
4. A bar under each pane's header shows the state, the number of relays used, and
   **Break link** (or **Resume** when paused).

The relay limit defaults to 6 relays. Linking requires both agents to be idle.

## What it does and does not do

- Claude Code only for now: the agent must accept `--settings` and report turns
  through hooks. Other agents need their own turn source.
- Local panes only. An SSH pane or a WSL pane cannot reach ZeroG's loopback
  listener, so the button is disabled for them.
- Agents started before ZeroG launched (or outside this feature) cannot be linked;
  launch them with the link button.
- ZeroG only relays what the agent itself reports as its final message. It never
  reads the screen, so prompts, spinners and tool output are never forwarded.
- Two-way relay only. One-way relay, mid-loop message injection and more than two
  panes are on the roadmap (`.hermes/plans/2026-10-01_pane-link-agent-relay.md`).

## When the link pauses or ends

| Situation | What happens |
| --- | --- |
| The partner is mid-turn (you are using it) | Pauses, holds the reply, **Resume** delivers it |
| The partner is waiting for you (permission prompt) | Pauses; answer it, then **Resume** |
| A reply is empty | Pauses |
| No reply within 10 minutes (approval left open, Esc interrupt, API error) | Pauses |
| The relay limit is reached | Ends |
| Either agent exits, or a pane is closed | Ends |
| You click **Break link** | Removed |

`/clear` inside an agent does not end the link.

## How it works

```
claude (pane A) --hooks--> 127.0.0.1:<port>/hook/<token> --> PaneLinkController
                                                              |
        paste + Enter into pane B <---- framed, sanitised reply
```

- `src/main/agent-hook-server.ts` listens on an ephemeral port on `127.0.0.1`. Each
  launched agent gets a random 192-bit token in its URL and its own settings file
  (mode 0600, deleted when the pane closes or the app quits). The token also fixes
  which pane an event belongs to, so a payload cannot claim to be another pane.
- Four hook events are observed: `UserPromptSubmit` (agent busy), `Stop` (turn
  finished, carries `last_assistant_message`), `Notification` (waiting for you) and
  `SessionEnd`. The hook response is always an empty object: ZeroG never blocks or
  steers the agent.
- `src/main/pane-link.ts` is the controller. It owns no sockets or terminals, which
  is why every rule above has a unit test with a fake clock.
- Delivery is a bracketed paste followed, 300 ms later, by Enter, so a multi-line
  reply arrives as one prompt.

## Safety design

Pane link is an agent loop, so it follows the project rule of explicit design and a
visible, easy break.

- Started by you, between two agents ZeroG launched, for a bounded number of relays.
- Visible on both panes; one click to break; it also ends if either agent exits.
- Never types into a running turn: if the partner is busy or waiting on you, the link
  pauses and holds the reply.
- Relayed text is untrusted input to the receiving agent. It is stripped of control
  characters (an ESC could end the bracketed paste early and have the rest typed as
  keystrokes), capped at 16,000 characters, and prefixed with a line saying it is
  another agent's message and not the user's. The prefix lowers the chance an agent
  treats the reply as an instruction from you; it is not a guarantee. Keep the relay
  limit low when agents have permission to run tools, and do not link an agent that
  has read untrusted content with one that can act on it unattended.
- The listener is loopback only and answers 404 to unknown tokens. It carries no
  credentials of yours.
- Terminal output is never parsed, so password, passphrase and host-key prompts cannot
  be forwarded.

## Known limits

- Hooks run on the machine that runs the agent, so SSH panes are out of scope until
  there is a way back to ZeroG.
- A durable `screen` session that outlives ZeroG keeps pointing at the old listener
  port. After restarting ZeroG, launch the agent again from the link button.
- ZeroG cannot tell whether a pane is at a shell prompt (see `FEATURE-DEV.md`); like
  the AI button, the launch command is typed exactly as shown in the status line.
- A user's own Stop hooks may or may not run alongside the injected ones; this has
  not been verified.
- Verified on Windows with Claude Code 2.1.286.
