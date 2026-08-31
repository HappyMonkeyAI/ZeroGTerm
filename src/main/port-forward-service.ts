import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import type { PtyProcess, SpawnPty } from './session-service.js';
import { FORWARD_SETTLE_MS, buildForwardArgs, describeForward, readForwardOutcome } from './port-forward-protocol.js';
import { detectPrompt } from './sftp-protocol.js';
import type { PortForwardEvent, PortForwardInfo, PortForwardRequest } from '../shared/types.js';

// node-pty is a native addon with no ESM entry point, and this file is compiled
// as a module. Same shim as session-service.ts and sftp-service.ts.
const require = createRequire(import.meta.url);

/** A ceiling on live tunnels, so a stuck panel cannot spawn clients forever. */
const MAX_FORWARDS = 16;

/** Nothing at all from the client within this long means the host never answered. */
const FIRST_BYTE_MS = 20000;

/** Kept small: this is a debug log, not a terminal, and only the tail matters. */
const BUFFER_CHARS = 8000;

/** How the client's own line endings behave, as with the transfer side. */
const TERMINATOR = '\n';

type Forward = {
  info: PortForwardInfo;
  pty: PtyProcess;
  buffer: string;
  /** Resolves once the tunnel is up or has definitively failed. */
  settle: { resolve: (info: PortForwardInfo) => void; reject: (error: Error) => void } | null;
  settleTimer: ReturnType<typeof setTimeout> | undefined;
  firstByteTimer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
};

/**
 * The `ssh -N` processes behind shared ports.
 *
 * One process per tunnel. It cannot be otherwise: a forward cannot be added to
 * the connection a terminal pane already holds without either typing `~C`
 * escapes into the pty the user is typing in, or ControlMaster, which Windows
 * OpenSSH does not have. One process each also makes closing exact — kill that
 * process and that tunnel is gone, with nothing else disturbed.
 *
 * The pty is not for a remote tty; `-N` runs no remote command. It is so `ssh`
 * has a terminal to ask for a password on, the same reason the transfer side
 * uses one, which is why prompt handling here is `detectPrompt` unchanged.
 */
export class PortForwardService {
  private forwards = new Map<string, Forward>();
  private readonly spawnPty: SpawnPty;
  private readonly onEvent: (event: PortForwardEvent) => void;
  private readonly settleMs: number;

  constructor(options: {
    spawnPty?: SpawnPty;
    onEvent?: (event: PortForwardEvent) => void;
    /** Overridden in tests so they do not wait out the real fallback. */
    settleMs?: number;
  } = {}) {
    this.spawnPty = options.spawnPty ?? ((file, args, ptyOptions) => require('node-pty').spawn(file, args, ptyOptions));
    this.onEvent = options.onEvent ?? (() => undefined);
    this.settleMs = options.settleMs ?? FORWARD_SETTLE_MS;
  }

  list(): PortForwardInfo[] {
    return [...this.forwards.values()].map((forward) => ({ ...forward.info }));
  }

  /**
   * Open a tunnel, resolving once it is actually listening.
   *
   * A password or host-key question arrives as an event while this is still
   * pending, and is answered with answerPrompt() — the same shape as the
   * transfer panel, because it is the same client asking.
   */
  async open(request: PortForwardRequest): Promise<PortForwardInfo> {
    // Built before anything is spawned, so an invalid request is a sentence
    // rather than a process that dies a moment later.
    const { file, args, spec } = buildForwardArgs(request);

    const existing = this.findConflict(request);
    if (existing) {
      throw new Error(
        `Port ${request.listenPort} is already shared ${existing.direction === 'local' ? 'from' : 'to'} ${existing.target}.`
      );
    }
    if (this.forwards.size >= MAX_FORWARDS) {
      throw new Error('Too many shared ports. Close one and try again.');
    }

    const id = request.id ?? `forward:${randomUUID()}`;
    // Logged because which client got picked, and with which spec, is the first
    // thing worth knowing when a tunnel does not work on someone else's machine.
    console.log('[zerog] forward open', { file, args });

    const info: PortForwardInfo = { ...request, id, status: 'connecting' };
    const pty = this.spawnPty(file, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: homedir(),
      env: process.env
    });

    const forward: Forward = { info, pty, buffer: '', settle: null, settleTimer: undefined, firstByteTimer: undefined, closed: false };
    this.forwards.set(id, forward);
    pty.onData((data) => this.receive(forward, data));
    pty.onExit(() => this.handleExit(forward));
    this.emitStatus(forward);

    return new Promise<PortForwardInfo>((resolve, reject) => {
      forward.settle = { resolve, reject };
      forward.firstByteTimer = setTimeout(() => {
        this.fail(forward, `${describeForward(request)} did not answer.`);
      }, FIRST_BYTE_MS);
    });
  }

  answerPrompt(forwardId: string, answer: string): void {
    const forward = this.forwards.get(forwardId);
    if (!forward) throw new Error('That shared port is no longer open.');
    if (/[\r\n]/.test(answer)) throw new Error('An answer must be a single line.');
    lastQuestion.delete(forwardId);
    forward.pty.write(`${answer}${TERMINATOR}`);
  }

  /**
   * Close a tunnel.
   *
   * There is no graceful handshake to attempt: `ssh -N` is doing nothing but
   * holding the forward open, so killing it is the clean way to let it go.
   */
  close(forwardId: string): void {
    const forward = this.forwards.get(forwardId);
    if (!forward) return;
    this.destroy(forward, 'Closed.');
  }

  closeAll(): void {
    for (const id of [...this.forwards.keys()]) this.close(id);
  }

  /**
   * A tunnel that already binds what this request wants.
   *
   * Checked here rather than only in the renderer because a second listener on
   * the same port cannot work, and spawning a client to find that out gives the
   * user an ssh error instead of a sentence. A local forward's port is bound on
   * this machine and a remote forward's on the far host, so the two only
   * conflict with their own kind — and a remote one only per host.
   */
  private findConflict(request: PortForwardRequest): PortForwardInfo | undefined {
    return this.list().find((candidate) => {
      if (candidate.id === request.id) return false;
      if (candidate.listenPort !== request.listenPort) return false;
      if (candidate.direction !== request.direction) return false;
      return request.direction === 'local' || candidate.target === request.target;
    });
  }

  private receive(forward: Forward, data: string): void {
    if (forward.closed) return;
    clearTimeout(forward.firstByteTimer);
    forward.firstByteTimer = undefined;
    forward.buffer = (forward.buffer + data).slice(-BUFFER_CHARS);

    const question = detectPrompt(forward.buffer);
    if (question) {
      // Only once per question: a rejected password is followed by the very same
      // prompt text, and the user has to be given the field again.
      if (lastQuestion.get(forward.info.id) !== question.text) {
        lastQuestion.set(forward.info.id, question.text);
        this.onEvent({ type: 'prompt', forwardId: forward.info.id, prompt: question });
      }
      return;
    }

    const outcome = readForwardOutcome(forward.buffer, forward.info.direction);
    if (!outcome) return;
    if (outcome.kind === 'failed') {
      this.fail(forward, outcome.reason);
      return;
    }
    if (outcome.kind === 'open') {
      this.succeed(forward);
      return;
    }
    // Authenticated but not yet listening. Give the client a moment to say it
    // started, and take silence as success rather than failing a tunnel that an
    // ssh build words differently from the one this was written against.
    if (!forward.settleTimer) {
      forward.settleTimer = setTimeout(() => {
        if (!forward.closed && forward.info.status === 'connecting') this.succeed(forward);
      }, this.settleMs);
    }
  }

  private succeed(forward: Forward): void {
    clearTimeout(forward.settleTimer);
    forward.settleTimer = undefined;
    forward.info.status = 'open';
    delete forward.info.message;
    this.emitStatus(forward);
    const settle = forward.settle;
    forward.settle = null;
    settle?.resolve({ ...forward.info });
  }

  private fail(forward: Forward, reason: string): void {
    const settle = forward.settle;
    forward.settle = null;
    forward.info.status = 'error';
    forward.info.message = reason;
    this.emitStatus(forward);
    this.destroy(forward, reason, { keepStatus: true });
    if (settle) settle.reject(new Error(reason));
  }

  /**
   * The client exited on its own.
   *
   * With ExitOnForwardFailure this is how a forward that could not bind reports
   * itself, so the buffer is worth one more read before falling back to a
   * generic message.
   */
  private handleExit(forward: Forward): void {
    if (forward.closed) return;
    const outcome = readForwardOutcome(forward.buffer, forward.info.direction);
    const reason = outcome?.kind === 'failed'
      ? outcome.reason
      : forward.info.status === 'open'
        ? 'The connection closed.'
        : `Could not share port ${forward.info.listenPort}.`;
    this.fail(forward, reason);
  }

  private destroy(forward: Forward, message: string, options: { keepStatus?: boolean } = {}): void {
    if (forward.closed) return;
    forward.closed = true;
    clearTimeout(forward.settleTimer);
    clearTimeout(forward.firstByteTimer);
    try {
      forward.pty.kill();
    } catch {
      /* already gone */
    }
    this.forwards.delete(forward.info.id);
    lastQuestion.delete(forward.info.id);
    if (!options.keepStatus) {
      forward.info.status = 'idle';
      this.emitStatus(forward);
    }
    this.onEvent({ type: 'closed', forwardId: forward.info.id, message });
  }

  private emitStatus(forward: Forward): void {
    this.onEvent({ type: 'status', forward: { ...forward.info } });
  }
}

/** The last question each tunnel asked, so it is only surfaced once. */
const lastQuestion = new Map<string, string>();
