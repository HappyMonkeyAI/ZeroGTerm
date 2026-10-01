// PROTOTYPE - throwaway (see NOTES.md). The pure part: worth lifting if the idea survives.
//
// Question: can "the other agent's reply" be recovered from a raw PTY stream using
// only an output-quiet timer, and when does that break?
//
// Pure state machine: no I/O. Feed it pane output and clock ticks; it returns the
// writes it wants performed.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC = new RegExp(ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)', 'g');
const CSI = new RegExp(ESC + '\\[[0-9;?<=>]*[ -/]*[@-~]', 'g');
const SHORT = new RegExp(ESC + '[()#%*+][0-9A-Za-z]|' + ESC + '[=><78MDEHc]', 'g');
export const strip = (s) => s.replace(OSC, '').replace(CSI, '').replace(SHORT, '').replace(new RegExp(BEL, 'g'), '');

export function createRelay({ quietMs = 3000, minWaitMs = 4000, cap = 4, frame = (from, text) => `Message from the other agent (${from}):\n${text}` } = {}) {
  const s = {
    phase: 'idle', // idle | waiting | broken
    waitingOn: null,
    sentAt: 0,
    lastDataAt: 0,
    buf: '',
    turns: 0,
    cap,
    brokenReason: null,
    transcript: [], // {turn, from, text}
  };

  const other = (p) => (p === 'a' ? 'b' : 'a');
  const wait = (pane, now) => Object.assign(s, { phase: 'waiting', waitingOn: pane, sentAt: now, lastDataAt: now, buf: '' });

  return {
    state: s,
    start(pane, text, now) {
      wait(pane, now);
      return [{ type: 'send', to: pane, text }];
    },
    onData(pane, raw, now) {
      if (s.phase !== 'waiting' || pane !== s.waitingOn) return [];
      s.lastDataAt = now;
      s.buf += strip(raw);
      return [];
    },
    tick(now) {
      if (s.phase !== 'waiting') return [];
      const quiet = now - s.lastDataAt >= quietMs;
      const old = now - s.sentAt >= minWaitMs;
      if (!(quiet && old)) return [];
      const reply = s.buf.replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const from = s.waitingOn;
      s.turns += 1;
      s.transcript.push({ turn: s.turns, from, text: reply });
      if (reply.length === 0) return this.breakLink('empty reply (agent went quiet with nothing to forward)');
      if (s.turns >= s.cap) return this.breakLink('turn cap');
      const to = other(from);
      wait(to, now);
      return [{ type: 'send', to, text: frame(from, reply) }];
    },
    breakLink(reason) {
      s.phase = 'broken';
      s.brokenReason = reason;
      return [{ type: 'broken', reason }];
    },
  };
}
