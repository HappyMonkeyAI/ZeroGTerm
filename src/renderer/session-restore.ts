// How to get a remembered session back.
//
// Two callers need this same decision: the history popover, and restoring a
// workspace after a relaunch. It has to be one rule — a workspace that
// reconnected differently from the history entry for the same shell would be a
// second, quietly diverging implementation of the app's central promise.
//
// The decision is returned rather than performed, the way pane-layout.ts
// returns a PaneAction, so it can be asserted on directly and so the component
// stays the only thing that touches state or the pty.

import type { KnownConnection, SessionInfo } from '../shared/types';
import { normalizeHost } from './remote-screens';

/**
 * What is remembered about a session, and enough to find or rebuild it.
 *
 * Deliberately not a SessionInfo: what survives a relaunch is a description,
 * not the session. `id` is the last id it had, which is worth trying first —
 * a local screen session's id is derived from its name and comes back
 * identical, while an SSH session's is a fresh uuid each launch.
 */
export type SessionDescriptor = {
  id?: string;
  name: string;
  kind: 'local' | 'ssh';
  host?: string;
  screenName?: string;
  sshTarget?: string;
  backend?: string;
};

export type RestoreAction =
  /** The session is already running: just point a pane at it. */
  | { kind: 'attach'; sessionId: string }
  /** Reachable through a saved connection, which knows the port and identity. */
  | { kind: 'attach-remote-screen'; connection: KnownConnection; screenName: string; name: string }
  /** Open SSH ourselves; `screenCommand` re-enters the screen once a prompt appears. */
  | { kind: 'create-ssh'; target: string; name: string; screenCommand?: string }
  /** Nothing can be done without asking the user for more. */
  | { kind: 'unavailable'; reason: string };

/**
 * The saved connection for a host, or nothing.
 *
 * SessionInfo.host is a whole SSH target and may carry a user and a port, while
 * KnownConnection.hostName is bare, so both sides are normalised before being
 * compared. Matching is exact afterwards: this decides which machine to open a
 * shell on, and a substring rule would happily match a connection aliased `db`
 * to a session on `db.internal.example.com`.
 */
export function findConnection(host: string | undefined, connections: KnownConnection[]): KnownConnection | undefined {
  if (!host) return undefined;
  const wanted = normalizeHost(host);
  if (!wanted) return undefined;
  return connections.find(
    (connection) => normalizeHost(connection.hostName ?? '') === wanted || connection.alias === wanted
  );
}

/**
 * The `screen` session a descriptor refers to, if any.
 *
 * A session recorded before it had a screen name still says `backend: 'screen'`,
 * and for those the session name *is* the screen name — that is how
 * createLocal names them.
 */
function screenNameFor(descriptor: SessionDescriptor): string | undefined {
  if (descriptor.screenName) return descriptor.screenName;
  return descriptor.backend === 'screen' ? descriptor.name : undefined;
}

/**
 * Find a live session already running a given `screen`.
 *
 * Kind is the tiebreaker rather than a filter: a local and a remote screen can
 * share a name, and then the one of the remembered kind is the one meant.
 */
function findByScreenName(screenName: string, kind: SessionDescriptor['kind'], sessions: SessionInfo[]): SessionInfo | undefined {
  return (
    sessions.find((session) => session.screenName === screenName && session.kind === kind) ??
    sessions.find((session) => session.screenName === screenName)
  );
}

/** Decide how to bring a remembered session back. */
export function planSessionRestore(
  descriptor: SessionDescriptor,
  sessions: SessionInfo[],
  connections: KnownConnection[]
): RestoreAction {
  // The id survives a relaunch for anything screen-backed, so this is the
  // common case on startup and costs nothing to try first.
  if (descriptor.id) {
    const exact = sessions.find((session) => session.id === descriptor.id);
    if (exact) return { kind: 'attach', sessionId: exact.id };
  }

  const screenName = screenNameFor(descriptor);
  if (screenName) {
    const running = findByScreenName(screenName, descriptor.kind, sessions);
    if (running) return { kind: 'attach', sessionId: running.id };

    if (descriptor.kind === 'local') {
      // Local screens are discovered, not built: if `screen -ls` did not list
      // it, the session is gone and reconnecting would silently start a new
      // shell wearing its name.
      return { kind: 'unavailable', reason: `No local screen session named ${screenName} is running` };
    }

    const connection = findConnection(descriptor.host, connections);
    if (connection) return { kind: 'attach-remote-screen', connection, screenName, name: descriptor.name };

    const target = descriptor.sshTarget || descriptor.host;
    if (!target) return { kind: 'unavailable', reason: `No host recorded for ${descriptor.name}` };
    return { kind: 'create-ssh', target, name: descriptor.name, screenCommand: `screen -x ${screenName}` };
  }

  if (descriptor.kind === 'local') {
    // No screen behind it, so the shell was a bare pty and died with the app.
    return { kind: 'unavailable', reason: `${descriptor.name} was not persistent and did not survive` };
  }

  const target = descriptor.sshTarget || descriptor.host;
  if (!target) return { kind: 'unavailable', reason: `No host recorded for ${descriptor.name}` };
  return { kind: 'create-ssh', target, name: descriptor.name };
}

/** The descriptor for a session as it is now, for storing or reconnecting. */
export function describeSession(session: SessionInfo): SessionDescriptor {
  return {
    id: session.id,
    name: session.name,
    kind: session.kind,
    host: session.host,
    screenName: session.screenName,
    sshTarget: session.sshTarget,
    backend: session.backend
  };
}
