// Turning a forwarding request into an ssh command line, and reading back
// whether the tunnel came up.
//
// Kept apart from the service so the part that decides what `ssh` is asked to do
// can be tested exhaustively without spawning anything. That matters more here
// than usual: every field lands in an argv element, and the whole point of the
// feature is to open a listening socket.

import { parseSshTarget, sshExecutable } from './session-service.js';
import { isSshHostName } from './ssh-inventory.js';
import type { ShellCatalogOptions } from './shell-catalog.js';
import type { ForwardBind, ForwardDirection, PortForwardRequest } from '../shared/types.js';

/** Where traffic goes when the request does not say. */
const DEFAULT_DESTINATION_HOST = 'localhost';

/**
 * How long to wait for a tunnel to declare itself before assuming it is up.
 *
 * Only a fallback: an ssh that has authenticated and gone quiet without saying
 * it started listening is almost certainly listening. The explicit signals in
 * readForwardOutcome are what normally settle this, and they arrive in
 * milliseconds.
 */
export const FORWARD_SETTLE_MS = 1500;

export type ForwardSpec = {
  file: string;
  args: string[];
  /** The -L/-R value, for logs and error messages. */
  spec: string;
};

function requirePort(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${what} must be a whole number between 1 and 65535.`);
  }
  return value;
}

function requireDirection(value: unknown): ForwardDirection {
  if (value !== 'local' && value !== 'remote') throw new Error('A forward must be local or remote.');
  return value;
}

function requireBind(value: unknown): ForwardBind {
  if (value !== 'loopback' && value !== 'all') throw new Error('A forward must bind to loopback or to all interfaces.');
  return value;
}

/**
 * The host on the receiving side of the tunnel.
 *
 * Vetted with the same rule as a HostName in ~/.ssh/config, because it is
 * concatenated into the forward spec — one argv element — and a value beginning
 * with '-' would be read by ssh's getopt as an option instead.
 *
 * Colons are then refused on top of that rule, which a HostName is allowed to
 * carry for an IPv6 literal. ssh splits a forward spec on colons, so an
 * unbracketed IPv6 address there does not mean what it looks like: `[::1]` is
 * the syntax, and accepting a bare `::1` would silently build a spec describing
 * a different tunnel. Bracketed literals are a separate job, so this says no
 * rather than guessing.
 */
function requireDestinationHost(value: unknown): string {
  if (value === undefined || value === '') return DEFAULT_DESTINATION_HOST;
  if (typeof value !== 'string' || !isSshHostName(value)) {
    throw new Error('The destination host must be a hostname or IP address.');
  }
  if (value.includes(':')) {
    throw new Error('An IPv6 destination is not supported yet. Use a hostname or an IPv4 address.');
  }
  return value;
}

/**
 * The bind address to put in the spec, or nothing.
 *
 * The two directions are not symmetric here, and it is the server's rule that
 * makes them differ. A `-L` forward binds on this machine, so the address is
 * ours to state and is always stated. A `-R` forward binds on the remote, where
 * sshd's GatewayPorts decides: the default (`no`) binds loopback and rejects a
 * client-specified address outright, so loopback has to be expressed by saying
 * nothing at all. `*` is used for the wide case because it is accepted under
 * both `yes` and `clientspecified`.
 */
function bindPrefix(direction: ForwardDirection, bind: ForwardBind): string {
  if (direction === 'local') return bind === 'all' ? '0.0.0.0:' : '127.0.0.1:';
  return bind === 'all' ? '*:' : '';
}

/**
 * Build the command line for a forward.
 *
 * Two options carry most of the weight:
 *
 * `ExitOnForwardFailure=yes` — without it, ssh stays connected when the forward
 * cannot bind, and there is no way to tell a working tunnel from a useless one
 * short of trying to use it. With it, a forward that fails is a process that
 * exits, and the UI can say so.
 *
 * `-v` — so that the tunnel being up is something ssh said rather than something
 * we assumed. `-N` produces no output of its own on success, so without this the
 * only signal available is the absence of an error.
 */
export function buildForwardArgs(request: PortForwardRequest, options: ShellCatalogOptions = {}): ForwardSpec {
  const direction = requireDirection(request.direction);
  const bind = requireBind(request.bind);
  const listenPort = requirePort(request.listenPort, 'The port to open');
  const destinationPort = requirePort(request.destinationPort, 'The port to forward to');
  const destinationHost = requireDestinationHost(request.destinationHost);
  const { destination, port } = parseSshTarget(request.target);

  const spec = `${bindPrefix(direction, bind)}${listenPort}:${destinationHost}:${destinationPort}`;
  const args = ['-v', '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=20'];
  if (port) args.push('-p', port);
  args.push(direction === 'local' ? '-L' : '-R', spec);
  // '--' ends option parsing, so the destination can never be read as a flag.
  args.push('--', destination);
  return { file: sshExecutable(options), args, spec };
}

export type ForwardOutcome =
  | { kind: 'open' }
  | { kind: 'failed'; reason: string }
  | { kind: 'authenticated' };

const FAILURES: Array<{ pattern: RegExp; reason: (match: RegExpMatchArray) => string }> = [
  {
    pattern: /bind \[?([^\]\s]+)\]?:(\d+): (.+)/,
    reason: (match) => `Could not bind ${match[1]}:${match[2]} — ${match[3].trim()}.`
  },
  {
    pattern: /Warning: remote port forwarding failed for listen port (\d+)/,
    reason: (match) =>
      `The remote host refused to open port ${match[1]}. Its sshd may need GatewayPorts enabled to bind beyond loopback.`
  },
  {
    pattern: /channel_setup_fwd_listener_tcpip: cannot listen to port: (\d+)/,
    reason: (match) => `Could not listen on port ${match[1]}.`
  },
  { pattern: /Permission denied \(([^)]*)\)/, reason: (match) => `Authentication failed (${match[1]}).` },
  { pattern: /(?:ssh: )?Could not resolve hostname ([^\s:]+)/, reason: (match) => `Could not resolve ${match[1]}.` },
  { pattern: /Connection (?:refused|timed out|closed) by ([^\s]+)/, reason: (match) => `The host ${match[1]} refused the connection.` },
  { pattern: /(ssh: connect to host [^\r\n]+)/, reason: (match) => `${match[1].trim()}.` },
  { pattern: /Host key verification failed/, reason: () => 'Host key verification failed.' }
];

/**
 * What the client's output so far says about the tunnel.
 *
 * Read from the whole buffer rather than the tail: `-v` is talkative, and the one
 * line that matters is followed by many that do not. Failure is checked before
 * success because ssh reports a partial success — one forward of several — while
 * still exiting.
 */
export function readForwardOutcome(buffer: string, direction: ForwardDirection): ForwardOutcome | null {
  for (const { pattern, reason } of FAILURES) {
    const match = buffer.match(pattern);
    if (match) return { kind: 'failed', reason: reason(match) };
  }

  const success = direction === 'local'
    ? /Local forwarding listening on \S+ port (\d+)/
    : /remote forward success for: listen (\d+)/;
  if (success.test(buffer)) return { kind: 'open' };

  // Not proof of a tunnel, but it does mean the connection got that far — the
  // service uses it to start the settle timer rather than waiting the full
  // timeout on a host that never answered at all.
  if (/Authentication succeeded|debug1: Entering interactive session/.test(buffer)) {
    return { kind: 'authenticated' };
  }
  return null;
}

/** How a forward reads in the UI and in a log line. */
export function describeForward(request: PortForwardRequest): string {
  const destinationHost = request.destinationHost || DEFAULT_DESTINATION_HOST;
  const listener = request.bind === 'all' ? '0.0.0.0' : 'localhost';
  return request.direction === 'local'
    ? `${listener}:${request.listenPort} → ${destinationHost}:${request.destinationPort} on ${request.target}`
    : `${request.target}:${request.listenPort} → ${destinationHost}:${request.destinationPort} here`;
}
