import type { KnownConnection } from '../shared/types';

// Helpers for matching SSH sessions to known connections and for deciding when
// a freshly attached remote shell is ready for input. Kept out of main.tsx so
// they can be unit tested — main.tsx calls createRoot at module scope and
// cannot be imported from a test.

/**
 * Reduce an SSH host to the bare hostname used by KnownConnection.hostName.
 *
 * SessionInfo.host holds the whole validated SSH target (see createSsh), so it
 * can carry both a user prefix and a port — `dev@example.com:2222` — while
 * hostName is bare. Comparing them directly leaves the Screens tab empty.
 *
 * A trailing `:port` is only removed when nothing else in the value looks like
 * a colon-separated address: ~/.ssh/config hostnames may be IPv6 literals, and
 * `::1` must not be truncated to `:`.
 */
export function normalizeHost(value: string): string {
  const withoutUser = value.replace(/^.*@/, '');
  const withoutPort = withoutUser.replace(/:\d+$/, '');
  return withoutPort.includes(':') ? withoutUser : withoutPort;
}

// Terminal control sequences sit between the prompt symbol and the end of the
// buffer, so they have to come off before the tail can be inspected.
//
// Built from named constants rather than written as regex literals: an escape
// or bell inside a literal is an invisible control character in the source,
// which is both easy to destroy in a later edit and reported as a bug by
// static analysis, since it is usually accidental. Here it is deliberate.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** OSC (window title), terminated by BEL or ESC backslash. */
const OSC_SEQUENCE = new RegExp(ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)', 'g');
/** CSI (colour, cursor movement). */
const CSI_SEQUENCE = new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g');

/**
 * Does the accumulated output end at something that looks like a shell prompt?
 *
 * Deliberately loose: bash, zsh, fish and PowerShell all end differently
 * ($, %, >, #), and prompts are usually wrapped in colour codes and an OSC
 * title sequence. Callers must treat a false result as "not yet known" rather
 * than "not ready" — prompt shapes vary too much to be the only signal, which
 * is why the caller also settles on a quiet gap in output.
 */
export function looksLikeShellPrompt(buffer: string): boolean {
  return /[#$%>]\s*$/.test(buffer.replace(OSC_SEQUENCE, '').replace(CSI_SEQUENCE, ''));
}

/** Keep the exact account/port chosen by the user; aliases retain SSH config. */
export function connectionTarget(connection: KnownConnection): string {
  const host = connection.source ? connection.alias : (connection.hostName ?? connection.alias);
  return `${connection.user ? connection.user + '@' : ''}${host}${connection.port ? ':' + connection.port : ''}`;
}

/** Discover only the active destination, including hosts absent from SSH config. */
export function screenConnection(target: string, known: KnownConnection[]): KnownConnection | undefined {
  const match = target.match(/^(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d+))?$/);
  if (!match) return undefined;
  const [, user, host, port] = match;
  const config = known.find((entry) => entry.alias === host);
  return { ...(config ?? {}), alias: config?.alias ?? host, hostName: config?.hostName ?? host,
    ...(user ? { user } : {}), ...(port ? { port: Number(port) } : {}) };
}
