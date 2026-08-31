import { describe, expect, it } from 'vitest';
import { describeSession, findConnection, planSessionRestore, type SessionDescriptor } from '../src/renderer/session-restore';
import type { KnownConnection, SessionInfo } from '../src/shared/types';

function session(overrides: Partial<SessionInfo> & Pick<SessionInfo, 'id'>): SessionInfo {
  return {
    name: overrides.id,
    kind: 'local',
    host: 'local',
    cwd: '/home/dev',
    status: 'detached',
    lastSeen: '2026-01-01T00:00:00.000Z',
    persistence: 'screen',
    scope: 'local',
    source: 'active',
    ...overrides
  };
}

const connections: KnownConnection[] = [
  { alias: 'build', hostName: 'build.example.com', user: 'dev', port: 2222 },
  { alias: 'db', hostName: 'db.internal.example.com' },
  { alias: 'bare-alias' }
];

describe('findConnection', () => {
  it('matches on the bare hostname behind a user and a port', () => {
    // SessionInfo.host carries the whole SSH target; hostName is bare.
    expect(findConnection('dev@build.example.com:2222', connections)?.alias).toBe('build');
  });

  it('matches a connection that only has an alias', () => {
    expect(findConnection('bare-alias', connections)?.alias).toBe('bare-alias');
  });

  it('does not match on a substring of a hostname', () => {
    // This decides which machine gets a shell opened on it. A two-way
    // `includes` rule matched alias 'db' against any host containing 'db'.
    expect(findConnection('db.other.example.com', connections)).toBeUndefined();
    expect(findConnection('example.com', connections)).toBeUndefined();
  });

  it('is undefined for a missing or empty host', () => {
    expect(findConnection(undefined, connections)).toBeUndefined();
    expect(findConnection('', connections)).toBeUndefined();
  });
});

describe('planSessionRestore', () => {
  it('attaches to the session the id still names', () => {
    const sessions = [session({ id: 'local:api', screenName: 'api' })];
    const descriptor: SessionDescriptor = { id: 'local:api', name: 'api', kind: 'local', screenName: 'api' };
    expect(planSessionRestore(descriptor, sessions, connections)).toEqual({ kind: 'attach', sessionId: 'local:api' });
  });

  it('finds a screen by name when the id has changed', () => {
    // An SSH session's id is a fresh uuid each launch, so the stored one is
    // stale while the screen on the far side is still the same shell.
    const sessions = [session({ id: 'ssh:new-uuid', kind: 'ssh', host: 'build.example.com', screenName: 'agent' })];
    const descriptor: SessionDescriptor = { id: 'ssh:old-uuid', name: 'agent', kind: 'ssh', host: 'build.example.com', screenName: 'agent' };
    expect(planSessionRestore(descriptor, sessions, connections)).toEqual({ kind: 'attach', sessionId: 'ssh:new-uuid' });
  });

  it('prefers a screen of the remembered kind when local and remote collide', () => {
    const sessions = [
      session({ id: 'ssh:1', kind: 'ssh', host: 'build.example.com', screenName: 'work' }),
      session({ id: 'local:work', kind: 'local', screenName: 'work' })
    ];
    const local: SessionDescriptor = { name: 'work', kind: 'local', screenName: 'work' };
    const remote: SessionDescriptor = { name: 'work', kind: 'ssh', host: 'build.example.com', screenName: 'work' };
    expect(planSessionRestore(local, sessions, connections)).toEqual({ kind: 'attach', sessionId: 'local:work' });
    expect(planSessionRestore(remote, sessions, connections)).toEqual({ kind: 'attach', sessionId: 'ssh:1' });
  });

  it('treats a screen-backed session with no screen name as named after itself', () => {
    const sessions = [session({ id: 'local:api', screenName: 'api' })];
    const descriptor: SessionDescriptor = { name: 'api', kind: 'local', backend: 'screen' };
    expect(planSessionRestore(descriptor, sessions, connections)).toEqual({ kind: 'attach', sessionId: 'local:api' });
  });

  it('goes through the saved connection for a remote screen that is not up', () => {
    // The connection knows the port and identity file; a bare host does not.
    const descriptor: SessionDescriptor = { name: 'agent', kind: 'ssh', host: 'dev@build.example.com:2222', screenName: 'agent' };
    expect(planSessionRestore(descriptor, [], connections)).toEqual({
      kind: 'attach-remote-screen',
      connection: connections[0],
      screenName: 'agent',
      name: 'agent'
    });
  });

  it('opens SSH itself and re-enters the screen when no connection matches', () => {
    const descriptor: SessionDescriptor = { name: 'agent', kind: 'ssh', host: 'dev@unknown.example.com', screenName: 'agent' };
    expect(planSessionRestore(descriptor, [], connections)).toEqual({
      kind: 'create-ssh',
      target: 'dev@unknown.example.com',
      name: 'agent',
      screenCommand: 'screen -x agent'
    });
  });

  it('prefers the recorded sshTarget over the host when opening SSH', () => {
    const descriptor: SessionDescriptor = { name: 'agent', kind: 'ssh', host: 'unknown.example.com', sshTarget: 'dev@unknown.example.com:2200' };
    expect(planSessionRestore(descriptor, [], connections)).toMatchObject({
      kind: 'create-ssh',
      target: 'dev@unknown.example.com:2200'
    });
  });

  it('reconnects a plain SSH session with no screen command', () => {
    const descriptor: SessionDescriptor = { name: 'shell', kind: 'ssh', host: 'dev@unknown.example.com' };
    expect(planSessionRestore(descriptor, [], connections)).toEqual({
      kind: 'create-ssh',
      target: 'dev@unknown.example.com',
      name: 'shell'
    });
  });

  it('refuses to invent a local screen that is not running', () => {
    // Reconnecting here would start a fresh shell wearing the old name, which
    // looks like a restore and is not one.
    const descriptor: SessionDescriptor = { name: 'api', kind: 'local', screenName: 'api' };
    const action = planSessionRestore(descriptor, [], connections);
    expect(action.kind).toBe('unavailable');
  });

  it('reports a non-persistent local session as gone', () => {
    const descriptor: SessionDescriptor = { name: 'api', kind: 'local', backend: 'bash' };
    const action = planSessionRestore(descriptor, [], connections);
    expect(action).toMatchObject({ kind: 'unavailable' });
    expect(action.kind === 'unavailable' && action.reason).toContain('not persistent');
  });

  it('reports an SSH session with no recorded host as unrestorable', () => {
    const descriptor: SessionDescriptor = { name: 'shell', kind: 'ssh' };
    expect(planSessionRestore(descriptor, [], connections).kind).toBe('unavailable');
  });

  it('does not match a live session of a different id and no screen', () => {
    // A plain SSH pane has nothing durable to match on, so it must reconnect
    // rather than adopt whatever SSH session happens to be open.
    const sessions = [session({ id: 'ssh:other', kind: 'ssh', host: 'unknown.example.com' })];
    const descriptor: SessionDescriptor = { id: 'ssh:stale', name: 'shell', kind: 'ssh', host: 'unknown.example.com' };
    expect(planSessionRestore(descriptor, sessions, connections).kind).toBe('create-ssh');
  });
});

describe('describeSession', () => {
  it('keeps only what is needed to find the session again', () => {
    const info = session({ id: 'ssh:1', name: 'agent', kind: 'ssh', host: 'build.example.com', sshTarget: 'dev@build.example.com', screenName: 'agent', backend: 'screen', cwd: '/srv/secret-project' });
    const descriptor = describeSession(info);
    expect(descriptor).toEqual({
      id: 'ssh:1',
      name: 'agent',
      kind: 'ssh',
      host: 'build.example.com',
      sshTarget: 'dev@build.example.com',
      screenName: 'agent',
      backend: 'screen'
    });
    // cwd is not carried: the history store already refuses to persist it.
    expect(Object.keys(descriptor)).not.toContain('cwd');
  });

  it('round-trips through planSessionRestore to an attach', () => {
    const info = session({ id: 'local:api', name: 'api', screenName: 'api' });
    expect(planSessionRestore(describeSession(info), [info], connections)).toEqual({ kind: 'attach', sessionId: 'local:api' });
  });
});
