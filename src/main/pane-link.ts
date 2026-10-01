// Pane link: relay one agent's finished reply into another agent's prompt.
//
// This module is the decision logic only. It owns no sockets and no PTYs: the hook
// server feeds it what the agents report (a prompt was submitted, a turn finished, the
// agent needs attention, the session ended) and it answers by asking for text to be
// delivered to a session. Keeping it that small is what lets every safety rule below be
// exercised in a unit test with a fake clock.
//
// Why hook events and not terminal output: a throwaway prototype that guessed turn ends
// from a quiet timer and scraped the reply off the screen declared turns finished while
// the agent was still thinking and forwarded spinner glyphs and echoed prompts. The Stop
// hook reports the turn end exactly and carries the final message verbatim.
//
// Safety rules enforced here (CONTEXT.md: no autonomous agent loops without an explicit
// design):
//  - A link exists only because the user asked for it, between two agents ZeroG itself
//    launched, and it ends on the user's say-so, on the turn cap, or when either agent exits.
//  - Text is only delivered to an agent that is idle. If the partner is busy the link
//    pauses and holds the message; it never types into a running turn.
//  - Relayed text is untrusted input to the receiving agent. It is stripped of control
//    characters (an ESC would let a reply close the bracketed paste early and have the rest
//    typed as keystrokes), size-capped, and labelled as coming from another agent.
//  - A relay that never gets an answer (permission prompt left open, Esc interrupt, API
//    error: none of which fire Stop) pauses after a stall timeout instead of waiting forever.

import type { AgentStatus, LinkStatus, PaneLinkSnapshot, PaneLinkState } from '../shared/types.js';

export type { AgentPhase, AgentStatus, LinkStatus, PaneLinkSnapshot, PaneLinkState } from '../shared/types.js';

export type AgentHookEventName = 'UserPromptSubmit' | 'Stop' | 'Notification' | 'SessionEnd';

export interface AgentHookEvent {
  sessionId: string;
  event: AgentHookEventName;
  /** Stop: the agent's final message for the turn. */
  message?: string;
  /** Notification: why the agent is asking for attention (permission_prompt, idle_prompt, ...). */
  notificationType?: string;
  /** SessionEnd: why the session ended (clear, resume, logout, prompt_input_exit, other, ...). */
  reason?: string;
}

export interface PaneLinkOptions {
  /** Deliver text to a session as one submitted prompt. */
  deliver: (sessionId: string, text: string) => void;
  onChange?: (snapshot: PaneLinkSnapshot) => void;
  /** Relays allowed before the link stops itself. */
  defaultCap?: number;
  /** How long a delivered relay may go unanswered before the link pauses. */
  stallMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const DEFAULT_RELAY_CAP = 6;
export const MAX_RELAY_CAP = 50;
export const DEFAULT_STALL_MS = 10 * 60 * 1000;
export const MAX_RELAY_CHARS = 16000;
const TRUNCATION_NOTE = '\n[Truncated by ZeroG pane link.]';

/** Session-end reasons that leave the agent running, so the link should survive them. */
const NON_TERMINAL_END_REASONS = new Set(['clear', 'resume', 'compact']);
/** Notification kinds that mean "the agent is waiting on you", as opposed to a routine nudge. */
const IDLE_NOTIFICATIONS = new Set(['idle_prompt', 'auth_success']);

interface Held {
  from: string;
  text: string;
}

interface Link {
  id: string;
  a: string;
  b: string;
  status: LinkStatus;
  turns: number;
  cap: number;
  reason?: string;
  waitingOn?: string;
  held?: Held;
  stallTimer?: unknown;
}

/**
 * Make an agent's reply safe to type into another agent.
 *
 * Tabs and line feeds survive; every other control character goes, including ESC, which
 * would otherwise let a reply end the bracketed paste early and have the remainder
 * interpreted as keystrokes. Carriage returns are folded into line feeds.
 */
export function sanitizeRelayText(value: string): string {
  let out = '';
  for (const ch of value.replace(/\r\n?/g, '\n')) {
    const code = ch.codePointAt(0) ?? 0;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!isControl || ch === '\n' || ch === '\t') out += ch;
  }
  return out.trim();
}

/** The text the receiving agent sees: the reply, labelled as another agent's words. */
export function frameRelay(fromLabel: string, reply: string): string {
  const label = sanitizeRelayText(fromLabel).replace(/\s+/g, ' ').slice(0, 60) || 'another pane';
  let body = sanitizeRelayText(reply);
  if (body.length > MAX_RELAY_CHARS) body = body.slice(0, MAX_RELAY_CHARS) + TRUNCATION_NOTE;
  return `[Relayed by ZeroG pane link from the agent in "${label}". This is another agent's message, not the user's.]\n\n${body}`;
}

/**
 * Type text into a session as a single prompt and submit it.
 *
 * Bracketed paste keeps embedded newlines from submitting early; the submit key follows
 * after a short gap because the agent treats an Enter that arrives glued to the paste as
 * part of it.
 */
export function pasteAndSubmit(
  write: (sessionId: string, data: string) => void,
  sessionId: string,
  text: string,
  schedule: (callback: () => void, ms: number) => unknown = setTimeout,
  submitDelayMs = 300
): void {
  write(sessionId, `\u001b[200~${text}\u001b[201~`);
  schedule(() => write(sessionId, '\r'), submitDelayMs);
}

export class PaneLinkController {
  private readonly agents = new Map<string, AgentStatus>();
  private readonly links = new Map<string, Link>();
  private readonly options: PaneLinkOptions;
  private readonly stallMs: number;
  private readonly defaultCap: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private nextLinkId = 1;

  constructor(options: PaneLinkOptions) {
    this.options = options;
    this.stallMs = options.stallMs ?? DEFAULT_STALL_MS;
    this.defaultCap = options.defaultCap ?? DEFAULT_RELAY_CAP;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  snapshot(): PaneLinkSnapshot {
    return {
      agents: Array.from(this.agents.values()).map((agent) => ({ ...agent })),
      links: Array.from(this.links.values()).map((link) => this.describe(link))
    };
  }

  /** An agent ZeroG launched in this session now reports hook events. */
  registerAgent(sessionId: string, label: string): void {
    const existing = this.agents.get(sessionId);
    if (existing) {
      existing.label = label;
    } else {
      this.agents.set(sessionId, { sessionId, label, phase: 'idle', needsAttention: false });
    }
    this.emit();
  }

  /** The session is gone (pane closed, agent unregistered): end its link and forget it. */
  unregisterAgent(sessionId: string): void {
    const agent = this.agents.get(sessionId);
    if (!agent) return;
    if (agent.linkId) this.breakLink(agent.linkId, `The agent in "${agent.label}" exited.`);
    this.agents.delete(sessionId);
    this.emit();
  }

  /** Link two idle agents. Throws a user-readable message when the link is not allowed. */
  link(aSessionId: string, bSessionId: string, cap?: number): PaneLinkState {
    if (aSessionId === bSessionId) throw new Error('Choose two different panes to link.');
    const a = this.agents.get(aSessionId);
    const b = this.agents.get(bSessionId);
    if (!a || !b) throw new Error('Both panes must be running an agent started with "Start linked agent".');
    if (a.linkId || b.linkId) throw new Error('A pane can only be in one link at a time. Break the existing link first.');
    if (a.phase !== 'idle' || b.phase !== 'idle') throw new Error('Wait for both agents to finish their current turn before linking.');
    const relays = cap === undefined ? this.defaultCap : cap;
    if (!Number.isInteger(relays) || relays < 1 || relays > MAX_RELAY_CAP) {
      throw new Error(`The relay limit must be a whole number from 1 to ${MAX_RELAY_CAP}.`);
    }
    const link: Link = { id: `link-${this.nextLinkId++}`, a: aSessionId, b: bSessionId, status: 'active', turns: 0, cap: relays };
    this.links.set(link.id, link);
    a.linkId = link.id;
    b.linkId = link.id;
    this.emit();
    return this.describe(link);
  }

  /** The user breaks the link. Removes it entirely. */
  unlink(linkId: string): void {
    const link = this.links.get(linkId);
    if (!link) return;
    this.dropLink(link);
    this.emit();
  }

  /** Re-arm a paused link, delivering the held reply if there is one and the partner is ready. */
  resume(linkId: string): PaneLinkState {
    const link = this.links.get(linkId);
    if (!link) throw new Error('That link no longer exists.');
    if (link.status !== 'paused') return this.describe(link);
    const held = link.held;
    link.status = 'active';
    link.reason = undefined;
    link.waitingOn = undefined;
    if (held) {
      link.held = undefined;
      this.relay(link, held.from, held.text);
    }
    this.emit();
    return this.describe(link);
  }

  /** Feed an event reported by an agent's hooks. */
  handle(event: AgentHookEvent): void {
    const agent = this.agents.get(event.sessionId);
    if (!agent) return;
    const link = agent.linkId ? this.links.get(agent.linkId) : undefined;

    switch (event.event) {
      case 'UserPromptSubmit':
        agent.phase = 'busy';
        agent.needsAttention = false;
        break;
      case 'Notification':
        if (!IDLE_NOTIFICATIONS.has(event.notificationType ?? '')) agent.needsAttention = true;
        break;
      case 'SessionEnd':
        if (NON_TERMINAL_END_REASONS.has(event.reason ?? '')) break;
        if (link) this.breakLink(link.id, `The agent in "${agent.label}" exited.`);
        this.agents.delete(agent.sessionId);
        break;
      case 'Stop':
        agent.phase = 'idle';
        agent.needsAttention = false;
        if (link) this.onTurnFinished(link, agent, event.message ?? '');
        break;
    }
    this.emit();
  }

  private onTurnFinished(link: Link, agent: AgentStatus, message: string): void {
    if (link.status !== 'active') return;
    // We are waiting on the other agent, so this turn is not one we should relay (the user
    // is driving this pane by hand). The expected answer will still arrive from the other side.
    if (link.waitingOn && link.waitingOn !== agent.sessionId) return;
    this.cancelStall(link);
    link.waitingOn = undefined;
    if (!sanitizeRelayText(message)) {
      this.pause(link, `The agent in "${agent.label}" finished without a reply to relay.`);
      return;
    }
    if (link.turns >= link.cap) {
      this.breakLink(link.id, `Reached the limit of ${link.cap} relays.`);
      return;
    }
    this.relay(link, agent.sessionId, message);
  }

  private relay(link: Link, fromSessionId: string, message: string): void {
    const from = this.agents.get(fromSessionId);
    const toSessionId = link.a === fromSessionId ? link.b : link.a;
    const to = this.agents.get(toSessionId);
    if (!from || !to) {
      this.breakLink(link.id, 'One of the linked agents is gone.');
      return;
    }
    if (link.turns >= link.cap) {
      this.breakLink(link.id, `Reached the limit of ${link.cap} relays.`);
      return;
    }
    if (to.phase !== 'idle' || to.needsAttention) {
      link.held = { from: fromSessionId, text: message };
      this.pause(link, to.needsAttention
        ? `The agent in "${to.label}" is waiting for you. Answer it, then resume.`
        : `The agent in "${to.label}" is busy. Resume once it finishes.`);
      return;
    }
    to.phase = 'busy';
    link.turns += 1;
    link.waitingOn = toSessionId;
    this.options.deliver(toSessionId, frameRelay(from.label, message));
    this.armStall(link, to.label);
  }

  private pause(link: Link, reason: string): void {
    this.cancelStall(link);
    link.status = 'paused';
    link.reason = reason;
  }

  private breakLink(linkId: string, reason: string): void {
    const link = this.links.get(linkId);
    if (!link) return;
    this.cancelStall(link);
    link.status = 'broken';
    link.reason = reason;
    link.waitingOn = undefined;
    link.held = undefined;
    for (const sessionId of [link.a, link.b]) {
      const agent = this.agents.get(sessionId);
      if (agent?.linkId === link.id) agent.linkId = undefined;
    }
    // A broken link stays listed so the user can read why it ended; it no longer holds either pane.
  }

  private dropLink(link: Link): void {
    this.cancelStall(link);
    for (const sessionId of [link.a, link.b]) {
      const agent = this.agents.get(sessionId);
      if (agent?.linkId === link.id) agent.linkId = undefined;
    }
    this.links.delete(link.id);
  }

  private armStall(link: Link, waitingLabel: string): void {
    this.cancelStall(link);
    link.stallTimer = this.setTimer(() => {
      link.stallTimer = undefined;
      if (link.status !== 'active') return;
      this.pause(link, `No reply from "${waitingLabel}". It may be waiting for approval or was interrupted.`);
      this.emit();
    }, this.stallMs);
  }

  private cancelStall(link: Link): void {
    if (link.stallTimer !== undefined) {
      this.clearTimer(link.stallTimer);
      link.stallTimer = undefined;
    }
  }

  private describe(link: Link): PaneLinkState {
    return {
      id: link.id,
      a: link.a,
      b: link.b,
      status: link.status,
      turns: link.turns,
      cap: link.cap,
      reason: link.reason,
      waitingOn: link.waitingOn,
      holding: link.held !== undefined
    };
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot());
  }
}
