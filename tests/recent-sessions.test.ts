import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_RECENT_SESSIONS, RecentSessionStore, normalizeFile } from '../src/main/recent-session-store';
import {
  EMPTY_RECENTS,
  cardState,
  localCwd,
  pickerEntries,
  planRecentLaunch,
  recentKey,
  recordRecents,
  timeAgo
} from '../src/renderer/recent-sessions';
import type { KnownConnection, RecentSession, SessionInfo, StoredRecentSessionFile } from '../src/shared/types';

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: 'id',
    name: 'term',
    kind: 'local',
    host: 'local',
    cwd: '/home/me',
    status: 'connected',
    lastSeen: '2026-11-01T00:00:00.000Z',
    ...overrides
  };
}

function recent(overrides: Partial<RecentSession> & Pick<RecentSession, 'name' | 'kind'>): RecentSession {
  const entry = { lastSeen: '2026-11-01T00:00:00.000Z', ...overrides } as RecentSession;
  return { ...entry, key: overrides.key ?? recentKey(entry) };
}

const NOW = new Date('2026-11-09T12:00:00.000Z');

describe('recent session store', () => {
  async function file() {
    return join(await mkdtemp(join(tmpdir(), 'zerog-recents-')), 'recent-sessions.json');
  }

  it('round trips and starts empty', async () => {
    const path = await file();
    expect(await new RecentSessionStore({ filePath: path }).load()).toEqual({ version: 1, sessions: [] });
    const saved: StoredRecentSessionFile = {
      version: 1,
      sessions: [recent({ name: 'api', kind: 'local', cwd: '/srv/api', backend: 'bash' })]
    };
    await new RecentSessionStore({ filePath: path }).save(saved);
    expect(await new RecentSessionStore({ filePath: path }).load()).toEqual(saved);
  });

  it('tolerates a malformed file and refuses a bad save', async () => {
    const path = await file();
    await writeFile(path, '{not json');
    const store = new RecentSessionStore({ filePath: path });
    expect(await store.load()).toEqual({ version: 1, sessions: [] });
    await expect(store.save({ version: 2, sessions: [] })).rejects.toThrow();
  });

  it('drops invalid entries, strips control characters, dedupes, sorts and caps', () => {
    const entries = Array.from({ length: MAX_RECENT_SESSIONS + 3 }, (_, index) =>
      recent({ name: `s${index}`, kind: 'local', lastSeen: new Date(Date.UTC(2026, 0, 1 + index)).toISOString() })
    );
    const normalized = normalizeFile({
      version: 1,
      sessions: [
        { key: 'k', kind: 'other', name: 'x', lastSeen: NOW.toISOString() },
        { key: 'k2', kind: 'local', name: 'x', lastSeen: 'not a date' },
        { ...entries[0], cwd: `/tmp/a${String.fromCharCode(7)}b` },
        entries[0],
        ...entries.slice(1)
      ]
    });
    expect(normalized?.sessions).toHaveLength(MAX_RECENT_SESSIONS);
    expect(normalized?.sessions[0].name).toBe(`s${MAX_RECENT_SESSIONS + 2}`);
    expect(normalized?.sessions.find((entry) => entry.name === 's0')).toBeUndefined();
    const withCwd = normalizeFile({ version: 1, sessions: [{ ...entries[0], cwd: `/tmp/a${String.fromCharCode(7)}b` }] });
    expect(withCwd?.sessions[0].cwd).toBe('/tmp/ab');
  });
});

describe('recordRecents', () => {
  it('records open sessions newest first, and strips directories unless remembered', () => {
    const open = [session({ name: 'api', cwd: '/srv/api', backend: 'bash' })];
    const off = recordRecents(EMPTY_RECENTS, open, { now: NOW, rememberDirectories: false, stamped: new Set() });
    expect(off.file.sessions[0]).toMatchObject({ name: 'api', lastSeen: NOW.toISOString() });
    expect(off.file.sessions[0].cwd).toBeUndefined();

    const on = recordRecents(EMPTY_RECENTS, open, { now: NOW, rememberDirectories: true, stamped: new Set() });
    expect(on.file.sessions[0].cwd).toBe('/srv/api');

    // Turning the setting off forgets what was already written.
    const forgotten = recordRecents(on.file, [], { now: NOW, rememberDirectories: false, stamped: on.stamped });
    expect(forgotten.file.sessions[0].cwd).toBeUndefined();
  });

  it('stamps a session once per run and returns the same file when nothing changed', () => {
    const open = [session({ name: 'api', cwd: '/srv/api' })];
    const first = recordRecents(EMPTY_RECENTS, open, { now: NOW, rememberDirectories: true, stamped: new Set() });
    const later = new Date(NOW.getTime() + 60_000);
    const same = recordRecents(first.file, open, { now: later, rememberDirectories: true, stamped: first.stamped });
    expect(same.file).toBe(first.file);

    const moved = recordRecents(first.file, [session({ name: 'api', cwd: '/srv/api/src' })], {
      now: later,
      rememberDirectories: true,
      stamped: first.stamped
    });
    expect(moved.file.sessions[0]).toMatchObject({ cwd: '/srv/api/src', lastSeen: NOW.toISOString() });
  });

  it('does not remember the ~ a fresh SSH shell reports', () => {
    const open = [session({ kind: 'ssh', name: 'web', host: 'web.example.com', sshTarget: 'me@web.example.com', cwd: '~' })];
    const result = recordRecents(EMPTY_RECENTS, open, { now: NOW, rememberDirectories: true, stamped: new Set() });
    expect(result.file.sessions[0].cwd).toBeUndefined();
  });
});

describe('pickerEntries', () => {
  it('leaves out sessions already on screen', () => {
    const api = recent({ name: 'api', kind: 'local' });
    const web = recent({ name: 'web', kind: 'ssh', sshTarget: 'me@web' });
    const file = { version: 1, sessions: [api, web] };
    expect(pickerEntries(file, [session({ name: 'api' })]).map((entry) => entry.name)).toEqual(['web']);
  });
});

describe('planRecentLaunch', () => {
  const connections: KnownConnection[] = [{ alias: 'web', hostName: 'web.example.com' }];

  it('opens a plain local shell in the remembered directory with its backend', () => {
    const plan = planRecentLaunch(recent({ name: 'api', kind: 'local', backend: 'wsl', wslDistribution: 'Ubuntu', cwd: '/srv/api' }), [], []);
    expect(plan).toEqual({ kind: 'create-local', request: { name: 'api', backend: 'wsl', wslDistribution: 'Ubuntu', cwd: '/srv/api' } });
    expect(cardState(plan).label).toBe('Open here');
  });

  it('ignores an unknown backend and a relative directory', () => {
    const plan = planRecentLaunch(recent({ name: 'api', kind: 'local', backend: 'nonsense', cwd: '~/api' }), [], []);
    expect(plan).toEqual({ kind: 'create-local', request: { name: 'api' } });
  });

  it('attaches to a running screen instead of opening another', () => {
    const live = session({ id: 'local:dev', name: 'dev', screenName: 'dev', backend: 'screen' });
    const plan = planRecentLaunch(recent({ name: 'dev', kind: 'local', screenName: 'dev', backend: 'screen' }), [live], []);
    expect(plan).toEqual({ kind: 'attach', sessionId: 'local:dev' });
    expect(cardState(plan).state).toBe('running');
  });

  it('recreates a local screen that has gone', () => {
    const plan = planRecentLaunch(recent({ name: 'dev', kind: 'local', screenName: 'dev', backend: 'screen', cwd: '/srv' }), [], []);
    expect(plan).toMatchObject({ kind: 'create-local', request: { name: 'dev', cwd: '/srv' } });
  });

  it('reattaches a remote screen through its saved connection, and opens plain SSH at home', () => {
    const screen = planRecentLaunch(recent({ name: 'build', kind: 'ssh', host: 'web.example.com', screenName: 'build' }), [], connections);
    expect(screen).toMatchObject({ kind: 'attach-remote-screen', screenName: 'build' });
    const plain = planRecentLaunch(recent({ name: 'web', kind: 'ssh', sshTarget: 'me@web.example.com', cwd: '/var/www' }), [], connections);
    expect(plain).toEqual({ kind: 'create-ssh', target: 'me@web.example.com', name: 'web' });
    expect(cardState(plain).label).toBe('New SSH shell');
  });
});

describe('helpers', () => {
  it('accepts only absolute local directories', () => {
    expect(localCwd('/srv')).toBe('/srv');
    expect(localCwd('C:\\Users\\me')).toBe('C:\\Users\\me');
    expect(localCwd('~/x')).toBeUndefined();
    expect(localCwd('relative')).toBeUndefined();
  });

  it('says roughly when', () => {
    expect(timeAgo(NOW.toISOString(), NOW)).toBe('just now');
    expect(timeAgo(new Date(NOW.getTime() - 3 * 3600_000).toISOString(), NOW)).toBe('3 hours ago');
    expect(timeAgo(new Date(NOW.getTime() - 50 * 3600_000).toISOString(), NOW)).toBe('2 days ago');
  });
});
