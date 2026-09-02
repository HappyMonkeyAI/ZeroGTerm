import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandHistoryStore, defaultCommandHistoryPath, normalizeFile } from '../src/main/command-history-store';

async function file() {
  return join(await mkdtemp(join(tmpdir(), 'zerog-cmdhist-')), 'command-history.json');
}

function store(path: string, at = '2026-09-01T12:00:00.000Z') {
  return new CommandHistoryStore({ filePath: path, now: () => new Date(at) });
}

const exists = (path: string) => access(path).then(() => true, () => false);

describe('recording', () => {
  it('round trips a command with its directory and status', async () => {
    const path = await file();
    await store(path).record({ command: 'git status', cwd: '/srv/app', host: 'local', kind: 'local', exitCode: 0 });
    const entries = await store(path).list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      command: 'git status',
      cwd: '/srv/app',
      host: 'local',
      kind: 'local',
      exitCode: 0,
      runs: 1,
      picks: 0
    });
  });

  it('counts a repeat rather than storing it twice', async () => {
    const path = await file();
    const s = store(path);
    await s.record({ command: 'npm test', cwd: '/srv/app' });
    await s.record({ command: 'npm test', cwd: '/srv/app' });
    await s.record({ command: 'npm test', cwd: '/srv/app' });
    const entries = await s.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].runs).toBe(3);
  });

  it('keeps the same command in two directories apart', async () => {
    // Two facts, not one: keeping them separate is what lets the palette put
    // the one from the current directory first.
    const path = await file();
    const s = store(path);
    await s.record({ command: 'npm test', cwd: '/srv/app' });
    await s.record({ command: 'npm test', cwd: '/srv/other' });
    expect(await s.list()).toHaveLength(2);
  });

  it('lets the latest outcome replace the last, including replacing a known one', async () => {
    // A command that used to work and now reports nothing must stop claiming
    // success.
    const path = await file();
    const s = store(path);
    await s.record({ command: 'make', cwd: '/srv/app', exitCode: 0 });
    expect((await s.list())[0].exitCode).toBe(0);
    await s.record({ command: 'make', cwd: '/srv/app', exitCode: 2 });
    expect((await s.list())[0].exitCode).toBe(2);
    await s.record({ command: 'make', cwd: '/srv/app' });
    expect((await s.list())[0].exitCode).toBeUndefined();
  });

  it('refuses a command that is empty once cleaned', async () => {
    // The guarantee is about what survives stripping, not about escape residue:
    // capture reads text xterm has already rendered, so a sequence never gets
    // this far as a sequence.
    const path = await file();
    const s = store(path);
    expect(await s.record({ command: '   ' })).toBeNull();
    expect(await s.record({ command: `${String.fromCharCode(7)}${String.fromCharCode(8)}` })).toBeNull();
    expect(await s.record({ command: '\t\n  ' })).toBeNull();
    expect(await s.list()).toEqual([]);
  });

  it('strips control characters a captured line could carry', async () => {
    const path = await file();
    const s = store(path);
    await s.record({ command: `git${String.fromCharCode(7)} status` });
    expect((await s.list())[0].command).toBe('git status');
  });

  it('writes the file only once a command is recorded', async () => {
    // Nothing on disk until there is something to put there: a store file is
    // how someone checks whether the feature is on.
    const path = await file();
    const s = store(path);
    expect(await exists(path)).toBe(false);
    await s.list();
    expect(await exists(path)).toBe(false);
    await s.record({ command: 'git status' });
    expect(await exists(path)).toBe(true);
  });
});

describe('picking', () => {
  it('counts a pick and freshens the entry', async () => {
    const path = await file();
    const s = store(path);
    const entry = await s.record({ command: 'git status', cwd: '/srv/app' });
    await s.pick(entry!.id);
    await s.pick(entry!.id);
    const [stored] = await s.list();
    expect(stored.picks).toBe(2);
    expect(stored.runs).toBe(1);
  });

  it('ignores a pick for something no longer there', async () => {
    const s = store(await file());
    await expect(s.pick('cmd:missing')).resolves.toBeUndefined();
  });
});

describe('clearing', () => {
  it('empties the history and removes the file', async () => {
    // A file left holding an empty list looks like a feature still running.
    const path = await file();
    const s = store(path);
    await s.record({ command: 'git status' });
    expect(await exists(path)).toBe(true);
    await s.clear();
    expect(await s.list()).toEqual([]);
    expect(await exists(path)).toBe(false);
  });

  it('survives clearing a history that was never written', async () => {
    const s = store(await file());
    await expect(s.clear()).resolves.toBeUndefined();
  });
});

describe('durability', () => {
  it('tolerates a malformed file', async () => {
    const path = await file();
    await writeFile(path, '{not json');
    expect(await store(path).list()).toEqual([]);
  });

  it('ignores a file from a future schema version', async () => {
    const path = await file();
    await writeFile(path, JSON.stringify({ version: 99, entries: [{ id: 'a', command: 'x', lastRun: '2026-01-01T00:00:00.000Z', runs: 1, picks: 0 }] }));
    expect(await store(path).list()).toEqual([]);
  });

  it('serialises concurrent writes', async () => {
    const path = await file();
    const s = store(path);
    await Promise.all([
      s.record({ command: 'one' }),
      s.record({ command: 'two' }),
      s.record({ command: 'three' })
    ]);
    const text = await readFile(path, 'utf8');
    expect(() => JSON.parse(text)).not.toThrow();
    expect((await store(path).list()).length).toBeGreaterThan(0);
  });

  it('names the file beside the other main-process state', () => {
    expect(defaultCommandHistoryPath(join('/tmp', 'userData'))).toBe(join('/tmp', 'userData', 'command-history.json'));
  });
});

describe('normalizeFile', () => {
  const one = (overrides: Record<string, unknown>) =>
    normalizeFile({
      version: 1,
      entries: [{ id: 'cmd:1', command: 'git status', lastRun: '2026-09-01T12:00:00.000Z', runs: 2, picks: 1, ...overrides }]
    })?.entries[0];

  it('drops an entry missing what identifies it', () => {
    expect(one({ id: '' })).toBeUndefined();
    expect(one({ command: '  ' })).toBeUndefined();
    expect(one({ lastRun: 'never' })).toBeUndefined();
    expect(one({ lastRun: undefined })).toBeUndefined();
  });

  it('repairs counts a hand-edited file made nonsense', () => {
    expect(one({ runs: -5 })?.runs).toBe(1);
    expect(one({ runs: 'many' })?.runs).toBe(1);
    expect(one({ picks: 1.5 })?.picks).toBe(0);
  });

  it('drops an exit status outside the range a shell can report', () => {
    expect(one({ exitCode: 300 })?.exitCode).toBeUndefined();
    expect(one({ exitCode: -1 })?.exitCode).toBeUndefined();
    expect(one({ exitCode: 'boom' })?.exitCode).toBeUndefined();
    expect(one({ exitCode: 130 })?.exitCode).toBe(130);
  });

  it('normalises the timestamp rather than trusting its spelling', () => {
    expect(one({ lastRun: '2026-09-01T12:00:00Z' })?.lastRun).toBe('2026-09-01T12:00:00.000Z');
  });

  it('drops a duplicated id', () => {
    const result = normalizeFile({
      version: 1,
      entries: [
        { id: 'cmd:1', command: 'first', lastRun: '2026-09-01T12:00:00.000Z', runs: 1, picks: 0 },
        { id: 'cmd:1', command: 'second', lastRun: '2026-09-01T12:00:00.000Z', runs: 1, picks: 0 }
      ]
    });
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0].command).toBe('first');
  });

  it('rejects a file with no entries array', () => {
    expect(normalizeFile({ version: 1 })).toBeUndefined();
    expect(normalizeFile({ version: 1, entries: 'nope' })).toBeUndefined();
    expect(normalizeFile(null)).toBeUndefined();
  });
});
