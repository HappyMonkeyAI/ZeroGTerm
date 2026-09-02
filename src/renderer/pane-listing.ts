// Where a pane's directory browser gets its listings.
//
// A local pane lists the filesystem. An SSH pane lists over an sftp connection,
// and that is the part this module exists for: the connection has a handle of
// its own, `sftpOpen` hands it back, and it is *not* the terminal session's id.
// Passing the session id instead is how the browser came to fail on every SSH
// pane with "This transfer connection is closed. Reopen the transfer panel." —
// the service was being asked about an id from the wrong namespace, and an id it
// does not know is indistinguishable from one that has closed.
//
// The same reason the connection is opened here rather than borrowed from the
// transfer panel: the panel may never have been opened, and a browser that only
// works after visiting another surface is not a browser. Opening is idempotent
// per host — the service reuses a live connection to the same target — so the
// two surfaces share one client rather than racing to spawn two.

import { joinRemote } from '../shared/files';
import { resolveStartPath } from './cwd-tracker';
import { sftpTargetForSession } from './sftp-view';
import type { DirectoryListing, SessionInfo, SftpSessionInfo } from '../shared/types';

/** The part of the preload API a listing needs. */
export type PaneListingApi = {
  listLocalDirectory(path?: string): Promise<DirectoryListing>;
  sftpOpen(target: string, cwd?: string): Promise<SftpSessionInfo>;
  sftpList(sessionId: string, path?: string): Promise<DirectoryListing>;
};

/**
 * An error that means the connection is gone rather than the path being wrong.
 *
 * Worth retrying once, because it is reached in ordinary use: cancelling a
 * password prompt in the transfer panel closes the shared connection, and a host
 * or a network drops one eventually. Matched on the message because that is all
 * an IPC rejection carries across the boundary.
 */
const GONE = /connection is closed|not connected|no such connection/i;

export type PaneListingSource = {
  /**
   * The listing function for a pane, stable for as long as the pane lives.
   *
   * Stability matters: the browser reloads whenever this function's identity
   * changes, so a fresh closure per render would list in a loop.
   */
  listerFor(session: SessionInfo): (path: string) => Promise<DirectoryListing>;
  /** The login directory of this pane's host, once a connection has reported it. */
  homeFor(sessionId: string): string | undefined;
  /**
   * Find out where this pane's host puts the user, opening a connection if
   * that is what it takes.
   *
   * An SSH shell reporting `~` has named a symbol, and the browser needs a path.
   * The login directory sftp reports on connecting is that path — the same
   * answer the transfer panel uses, and the reason neither has to run a command
   * in the user's terminal to find out.
   */
  learnHome(session: SessionInfo): Promise<string | undefined>;
  /** Drop what is remembered about a pane. Its connection is left alone. */
  forget(sessionId: string): void;
};

type Connection = { handle: string; home: string };

export function createPaneListingSource(api: () => PaneListingApi | null | undefined): PaneListingSource {
  const listers = new Map<string, (path: string) => Promise<DirectoryListing>>();
  const connections = new Map<string, Connection>();
  /** Opens in flight, so two listings starting together share one connection. */
  const opening = new Map<string, Promise<Connection>>();

  function required(): PaneListingApi {
    const current = api();
    if (!current) throw new Error('The terminal bridge is not available.');
    return current;
  }

  async function connect(session: SessionInfo, reopen = false): Promise<Connection> {
    if (reopen) {
      connections.delete(session.id);
      opening.delete(session.id);
    }
    const known = connections.get(session.id);
    if (known) return known;
    // Compared against undefined rather than tested for truth: a Promise is
    // always truthy, and the question here is whether one exists to join.
    const inFlight = opening.get(session.id);
    if (inFlight !== undefined) return inFlight;

    const target = sftpTargetForSession(session);
    if (!target) throw new Error(`${session.name} has no SSH host to list.`);

    // Opened with no directory, so the connection reports the login directory
    // rather than a guess; a `~` in the pane's path is resolved against it.
    const attempt = required()
      .sftpOpen(target)
      .then((info) => {
        const connection = { handle: info.id, home: info.cwd };
        connections.set(session.id, connection);
        return connection;
      })
      .finally(() => {
        opening.delete(session.id);
      });
    opening.set(session.id, attempt);
    return attempt;
  }

  /**
   * The path to ask sftp for.
   *
   * A pane's reported directory can be `~` or `~/projects` — that is what a
   * shell's prompt says, and it is what cwd-tracker faithfully reports. sftp
   * needs the real path.
   */
  function remotePath(path: string, home: string): string | undefined {
    if (!path) return undefined;
    const start = resolveStartPath(path);
    if (start.absolute) return start.absolute;
    if (start.homeRelative) return joinRemote(home, start.homeRelative);
    // `~` on its own, or something relative: the login directory is the only
    // place it can sensibly mean.
    return home;
  }

  async function listRemote(session: SessionInfo, path: string): Promise<DirectoryListing> {
    const connection = await connect(session);
    try {
      return await required().sftpList(connection.handle, remotePath(path, connection.home));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!GONE.test(message)) throw error;
      // Someone closed the connection out from under this pane. Opening again
      // is cheaper than telling the user to go and do it themselves.
      const revived = await connect(session, true);
      return await required().sftpList(revived.handle, remotePath(path, revived.home));
    }
  }

  return {
    listerFor(session: SessionInfo) {
      const existing = listers.get(session.id);
      if (existing) return existing;
      const lister = (path: string): Promise<DirectoryListing> =>
        session.kind === 'ssh'
          ? listRemote(session, path)
          : Promise.resolve().then(() => required().listLocalDirectory(path));
      listers.set(session.id, lister);
      return lister;
    },

    homeFor(sessionId: string) {
      return connections.get(sessionId)?.home;
    },

    async learnHome(session: SessionInfo) {
      if (session.kind !== 'ssh') return undefined;
      const known = connections.get(session.id);
      if (known) return known.home;
      return (await connect(session)).home;
    },

    forget(sessionId: string) {
      listers.delete(sessionId);
      connections.delete(sessionId);
      opening.delete(sessionId);
    }
  };
}
