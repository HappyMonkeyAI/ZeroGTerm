import { describe, expect, it, vi } from 'vitest';
import { createPaneListingSource, type PaneListingApi } from '../src/renderer/pane-listing';
import type { DirectoryListing, SessionInfo, SftpSessionInfo } from '../src/shared/types';

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'ssh:1',
    name: 'mint',
    kind: 'ssh',
    host: 'mint.local',
    sshTarget: 'stephen@mint.local',
    cwd: '~',
    status: 'connected',
    lastSeen: '2026-09-02T00:00:00.000Z',
    backend: 'ssh',
    scope: 'remote',
    source: 'active',
    ...overrides
  };
}

function listing(path: string): DirectoryListing {
  return { path, entries: [{ name: 'projects', kind: 'directory' }] };
}

/**
 * The transfer service's contract, as the renderer meets it across IPC.
 *
 * The two rules that matter are the ones the browser broke: a connection is
 * named by the handle `open` hands back, and an id it does not know is reported
 * as closed — indistinguishable, from out here, from one that really has closed.
 */
function fakeApi(options: { home?: string } = {}) {
  const home = options.home ?? '/home/stephen';
  const state = {
    opens: [] as Array<{ target: string; cwd?: string }>,
    lists: [] as Array<{ handle: string; path?: string }>,
    localLists: [] as Array<string | undefined>,
    /** Handles the service currently knows about. */
    live: new Set<string>(),
    nextHandle: 1
  };
  const api: PaneListingApi = {
    async listLocalDirectory(path?: string) {
      state.localLists.push(path);
      return listing(path ?? home);
    },
    async sftpOpen(target: string, cwd?: string): Promise<SftpSessionInfo> {
      state.opens.push({ target, cwd });
      const id = `sftp-${state.nextHandle++}`;
      state.live.add(id);
      return { id, target, cwd: cwd ?? home };
    },
    async sftpList(sessionId: string, path?: string) {
      state.lists.push({ handle: sessionId, path });
      if (!state.live.has(sessionId)) {
        throw new Error('This transfer connection is closed. Reopen the transfer panel.');
      }
      return listing(path ?? home);
    }
  };
  return { api, state };
}

describe('an SSH pane', () => {
  it('lists through the handle the connection reports, not the terminal session id', async () => {
    // The reported bug. `ssh:1` is the terminal's id and names no connection, so
    // the service answered "This transfer connection is closed" for every
    // listing, on every host.
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const result = await source.listerFor(session())('/home/stephen');

    expect(result.entries.map((entry) => entry.name)).toEqual(['projects']);
    expect(state.lists).toEqual([{ handle: 'sftp-1', path: '/home/stephen' }]);
    expect(state.lists.some((call) => call.handle === 'ssh:1')).toBe(false);
  });

  it('opens one connection however many listings are asked for', async () => {
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const lister = source.listerFor(session());
    await lister('/home/stephen');
    await lister('/etc');
    await lister('/var');
    expect(state.opens).toHaveLength(1);
  });

  it('opens one connection for listings that start together', async () => {
    // Two panes' worth of renders can land in the same tick, and each open is a
    // real ssh process against a per-host cap.
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const lister = source.listerFor(session());
    await Promise.all([lister('/etc'), lister('/var'), lister('/usr')]);
    expect(state.opens).toHaveLength(1);
  });

  it('opens to the login directory rather than guessing one', async () => {
    // Passing the pane's `~` as the start directory would ask sftp to cd
    // somewhere it may read as a literal name.
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    await source.listerFor(session())('~');
    expect(state.opens).toEqual([{ target: 'stephen@mint.local', cwd: undefined }]);
  });

  it('resolves a path the shell reported relative to home', async () => {
    // What the user hit after this bug's first symptom: an SSH pane's reported
    // directory is `~/projects`, which is a prompt's shorthand and not a path.
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const lister = source.listerFor(session({ cwd: '~/projects' }));
    await lister('~/projects');
    await lister('~');
    expect(state.lists.map((call) => call.path)).toEqual(['/home/stephen/projects', '/home/stephen']);
  });

  it('remembers the login directory, so a pane reporting ~ has a path', async () => {
    const { api } = fakeApi({ home: '/home/dev' });
    const source = createPaneListingSource(() => api);
    expect(source.homeFor('ssh:1')).toBeUndefined();
    expect(await source.learnHome(session())).toBe('/home/dev');
    expect(source.homeFor('ssh:1')).toBe('/home/dev');
  });

  it('learns the login directory once', async () => {
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    await source.learnHome(session());
    await source.learnHome(session());
    await source.listerFor(session())('/etc');
    expect(state.opens).toHaveLength(1);
  });

  it('reopens when the connection was closed underneath it', async () => {
    // Cancelling a password prompt in the transfer panel closes the shared
    // connection. The next listing should not make the user go and reopen
    // something they did not know they were using.
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const lister = source.listerFor(session());
    await lister('/etc');
    state.live.clear();

    const result = await lister('/etc');
    expect(result.entries).toHaveLength(1);
    expect(state.opens).toHaveLength(2);
    expect(state.lists.map((call) => call.handle)).toEqual(['sftp-1', 'sftp-1', 'sftp-2']);
  });

  it('reports a failure that is not the connection, without retrying', async () => {
    // A path that does not exist is the user's answer to have, and reopening a
    // working connection would only hide it.
    const { api, state } = fakeApi();
    const failing: PaneListingApi = {
      ...api,
      sftpList: vi.fn(async () => {
        throw new Error('No such file or directory');
      })
    };
    const source = createPaneListingSource(() => failing);
    await expect(source.listerFor(session())('/nope')).rejects.toThrow('No such file or directory');
    expect(state.opens).toHaveLength(1);
  });

  it('gives up when reopening does not help either', async () => {
    const { api } = fakeApi();
    const dead: PaneListingApi = {
      ...api,
      sftpList: async () => {
        throw new Error('This transfer connection is closed. Reopen the transfer panel.');
      }
    };
    const source = createPaneListingSource(() => dead);
    await expect(source.listerFor(session())('/etc')).rejects.toThrow('transfer connection is closed');
  });

  it('says so when the pane names no host to reach', async () => {
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const orphan = session({ id: 'ssh:2', sshTarget: undefined, host: 'local', name: 'ghost' });
    await expect(source.listerFor(orphan)('/etc')).rejects.toThrow('ghost has no SSH host to list');
    expect(state.opens).toEqual([]);
  });
});

describe('a local pane', () => {
  it('lists the filesystem and opens no connection', async () => {
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const local = session({ id: 'local:api', kind: 'local', host: 'local', backend: 'bash', sshTarget: undefined });
    await source.listerFor(local)('/home/stephen');
    expect(state.localLists).toEqual(['/home/stephen']);
    expect(state.opens).toEqual([]);
  });

  it('lists a WSL pane through the share path it was given', async () => {
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const wsl = session({ id: 'local:wsl', kind: 'local', host: 'local', backend: 'wsl', sshTarget: undefined });
    await source.listerFor(wsl)(String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`);
    expect(state.localLists).toEqual([String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`]);
  });

  it('has no login directory to learn', async () => {
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const local = session({ id: 'local:api', kind: 'local', sshTarget: undefined });
    expect(await source.learnHome(local)).toBeUndefined();
    expect(state.opens).toEqual([]);
  });
});

describe('the source itself', () => {
  it('hands out the same lister for a pane, so the browser does not reload forever', async () => {
    const { api } = fakeApi();
    const source = createPaneListingSource(() => api);
    expect(source.listerFor(session())).toBe(source.listerFor(session()));
  });

  it('forgets a pane without disturbing the others', async () => {
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const other = session({ id: 'ssh:2', name: 'build' });
    await source.learnHome(session());
    await source.learnHome(other);
    source.forget('ssh:1');
    expect(source.homeFor('ssh:1')).toBeUndefined();
    expect(source.homeFor('ssh:2')).toBe('/home/stephen');
    // And the pane can be used again afterwards.
    await source.listerFor(session())('/etc');
    expect(state.opens).toHaveLength(3);
  });

  it('reports a missing bridge rather than throwing something unreadable', async () => {
    const source = createPaneListingSource(() => null);
    await expect(source.listerFor(session())('/etc')).rejects.toThrow('terminal bridge is not available');
    const local = session({ id: 'local:api', kind: 'local' });
    await expect(source.listerFor(local)('/etc')).rejects.toThrow('terminal bridge is not available');
  });
});

describe('listing before the shell has said anything', () => {
  it('asks the connection where it is, rather than guessing', async () => {
    // A freshly connected SSH pane has run nothing, so there is no reported
    // directory. The connection has one of its own, the login directory, and
    // sftp answers a pathless list with it. Reported as the browser showing
    // nothing until pwd had been run by hand.
    const { api, state } = fakeApi({ home: '/home/stephen' });
    const source = createPaneListingSource(() => api);
    const listing = await source.listerFor(session())();
    expect(state.lists).toEqual([{ handle: 'sftp-1', path: undefined }]);
    expect(listing.path).toBe('/home/stephen');
  });

  it('reports the login directory to whoever is watching', async () => {
    // So a tilde the shell reports later resolves without a second round trip.
    const homes: Array<[string, string]> = [];
    const { api } = fakeApi({ home: '/home/dev' });
    const source = createPaneListingSource(() => api, (id, home) => homes.push([id, home]));
    await source.listerFor(session())();
    expect(homes).toEqual([['ssh:1', '/home/dev']]);
  });

  it('reports it once, not on every listing', async () => {
    const homes: string[] = [];
    const { api } = fakeApi();
    const source = createPaneListingSource(() => api, (_id, home) => homes.push(home));
    const lister = source.listerFor(session());
    await lister();
    await lister('/etc');
    await lister('/var');
    expect(homes).toHaveLength(1);
  });

  it('surfaces the reason a first listing failed', async () => {
    // The failure used to be swallowed: the browser said the pane had not
    // reported a directory, which is indistinguishable from a host that could
    // not be reached.
    const { api } = fakeApi();
    const refusing: PaneListingApi = {
      ...api,
      sftpOpen: async () => {
        throw new Error('stephen@ubuntu: Permission denied (publickey).');
      }
    };
    const source = createPaneListingSource(() => refusing);
    await expect(source.listerFor(session())()).rejects.toThrow('Permission denied');
  });

  it('still refuses to guess for a local pane', async () => {
    // A pathless local listing is answered with the Windows home directory,
    // which for a pane inside a WSL distribution is the wrong filesystem.
    const { api, state } = fakeApi();
    const source = createPaneListingSource(() => api);
    const wsl = session({ id: 'local:wsl', kind: 'local', host: 'local', backend: 'wsl', sshTarget: undefined });
    await source.listerFor(wsl)(String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`);
    expect(state.localLists).toEqual([String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`]);
  });
});
