// Decisions the transfer panel makes about a session, kept pure so they can be
// unit tested away from React and from the preload API.

import type { FileEntry, SessionInfo } from '../shared/types';

/**
 * The SSH destination to open a transfer connection to, or null when this
 * session is not one that has a remote side.
 *
 * `sshTarget` is the validated target the session was created from, and is what
 * the terminal itself connected with; `host` is the fallback for sessions
 * discovered rather than created — a remote screen, say, whose host is all that
 * was ever known about it.
 */
export function sftpTargetForSession(session: SessionInfo | null | undefined): string | null {
  if (!session || session.kind !== 'ssh') return null;
  const target = session.sshTarget || session.host;
  return target && target !== 'local' ? target : null;
}

/**
 * Why the transfer button is or is not available, in the words the tooltip uses.
 * A disabled control that does not say why is a control the user has to guess at.
 */
export function transferAvailability(session: SessionInfo | null | undefined): { available: boolean; reason: string } {
  if (!session) return { available: false, reason: 'Open an SSH session to transfer files' };
  if (!sftpTargetForSession(session)) {
    return { available: false, reason: `${session.name} is a local session — SFTP needs an SSH connection` };
  }
  return { available: true, reason: `Transfer files with ${session.host}` };
}

/** Can this entry be opened as a directory? Symlinks may point at one. */
export function isNavigable(entry: FileEntry): boolean {
  return entry.kind === 'directory' || entry.kind === 'symlink';
}

/**
 * The entries a transfer will actually move. Upload callers leave directories
 * disabled; remote downloads opt in because the SFTP service handles them with
 * a recursive `get -r`.
 */
export function transferable(entries: FileEntry[], selected: ReadonlySet<string>, allowDirectories = false): FileEntry[] {
  return entries.filter((entry) => selected.has(entry.name) && (allowDirectories || entry.kind !== 'directory'));
}

/** What the transfer button says, given what is selected. */
export function transferLabel(verb: string, count: number, noun = 'file'): string {
  if (count === 0) return verb;
  return `${verb} ${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * Toggle a row into or out of a selection.
 *
 * Plain clicks select one thing, because that is what a click means everywhere
 * else; holding a modifier accumulates.
 */
export function nextSelection(
  current: ReadonlySet<string>,
  name: string,
  additive: boolean,
  rangeStart?: string,
  orderedNames?: readonly string[]
): Set<string> {
  if (rangeStart && orderedNames) {
    const start = orderedNames.indexOf(rangeStart);
    const end = orderedNames.indexOf(name);
    if (start >= 0 && end >= 0) {
      const next = additive ? new Set(current) : new Set<string>();
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (const item of orderedNames.slice(low, high + 1)) next.add(item);
      return next;
    }
  }
  if (!additive) return new Set([name]);
  const next = new Set(current);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}
