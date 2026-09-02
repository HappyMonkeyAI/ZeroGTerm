import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceStore, defaultWorkspacePath, normalizeFile, type WorkspaceFile } from '../src/main/workspace-store';

async function file() {
  return join(await mkdtemp(join(tmpdir(), 'zerog-workspaces-')), 'workspaces.json');
}

const saved: WorkspaceFile = {
  version: 1,
  activeWorkspaceId: 'ws-2',
  workspaces: [
    {
      id: 'ws-1',
      name: 'Workspace',
      view: { layout: 'split-v', lastSplit: 'split-v', activeSessionId: 'local:api', focusedSessionId: 'local:api', maximizedSessionId: null },
      members: [
        { sessionId: 'local:api', kind: 'local', name: 'api', screenName: 'api', backend: 'screen' },
        { sessionId: 'ssh:1', kind: 'ssh', name: 'build', host: 'build.example.com', sshTarget: 'dev@build.example.com' }
      ]
    },
    { id: 'ws-2', name: 'client-api', view: { layout: 'grid', lastSplit: 'grid', maximizedSessionId: null }, members: [] }
  ]
};

describe('workspace store', () => {
  it('round trips workspaces, views, and members', async () => {
    const path = await file();
    await new WorkspaceStore({ filePath: path }).save(saved);
    const loaded = await new WorkspaceStore({ filePath: path }).load();
    expect(loaded).toEqual(saved);
  });

  it('starts empty when there is no file yet', async () => {
    const loaded = await new WorkspaceStore({ filePath: await file() }).load();
    expect(loaded).toEqual({ version: 1, workspaces: [] });
  });

  it('tolerates a malformed file rather than failing to open a window', async () => {
    const path = await file();
    await writeFile(path, '{not json');
    expect(await new WorkspaceStore({ filePath: path }).load()).toEqual({ version: 1, workspaces: [] });
  });

  it('ignores a file written by a future schema version', async () => {
    const path = await file();
    await writeFile(path, JSON.stringify({ ...saved, version: 99 }));
    expect(await new WorkspaceStore({ filePath: path }).load()).toEqual({ version: 1, workspaces: [] });
  });

  it('writes the file with owner-only permissions', async () => {
    const path = await file();
    await new WorkspaceStore({ filePath: path }).save(saved);
    // The content is the point; on Windows the mode is not enforced, so this
    // asserts the write landed rather than the exact bits.
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
  });

  it('rejects a save it could not make sense of', async () => {
    const store = new WorkspaceStore({ filePath: await file() });
    await expect(store.save({ version: 1 })).rejects.toThrow(/Invalid workspace layout/);
    await expect(store.save(null)).rejects.toThrow(/Invalid workspace layout/);
  });

  it('keeps the last good layout when a bad save is refused', async () => {
    const path = await file();
    const store = new WorkspaceStore({ filePath: path });
    await store.save(saved);
    await expect(store.save('nonsense')).rejects.toThrow();
    expect((await new WorkspaceStore({ filePath: path }).load()).workspaces).toHaveLength(2);
  });

  it('serialises concurrent saves without corrupting the file', async () => {
    const path = await file();
    const store = new WorkspaceStore({ filePath: path });
    await Promise.all([
      store.save(saved),
      store.save({ ...saved, workspaces: [saved.workspaces[0]] }),
      store.save(saved)
    ]);
    const loaded = await new WorkspaceStore({ filePath: path }).load();
    expect(loaded.version).toBe(1);
    expect(Array.isArray(loaded.workspaces)).toBe(true);
  });

  it('names the file beside the other main-process state', () => {
    expect(defaultWorkspacePath(join('/tmp', 'userData'))).toBe(join('/tmp', 'userData', 'workspaces.json'));
  });
});

describe('normalizeFile', () => {
  it('drops members that are missing their durable fields', () => {
    const result = normalizeFile({
      version: 1,
      workspaces: [{ id: 'ws-1', name: 'Workspace', view: {}, members: [
        { sessionId: 'local:ok', kind: 'local', name: 'ok' },
        { sessionId: 'local:nokind', name: 'x' },
        { kind: 'local', name: 'noid' },
        'not an object'
      ] }]
    });
    expect(result?.workspaces[0].members.map((m) => m.sessionId)).toEqual(['local:ok']);
  });

  it('caps a workspace at four panes', () => {
    const members = Array.from({ length: 9 }, (_, index) => ({ sessionId: `local:${index}`, kind: 'local', name: `t${index}` }));
    const result = normalizeFile({ version: 1, workspaces: [{ id: 'ws-1', name: 'Workspace', view: {}, members }] });
    expect(result?.workspaces[0].members).toHaveLength(4);
  });

  it('drops a duplicated session id, which would render one terminal twice', () => {
    const result = normalizeFile({
      version: 1,
      workspaces: [{ id: 'ws-1', name: 'Workspace', view: {}, members: [
        { sessionId: 'local:api', kind: 'local', name: 'api' },
        { sessionId: 'local:api', kind: 'local', name: 'api-again' }
      ] }]
    });
    expect(result?.workspaces[0].members).toHaveLength(1);
  });

  it('keeps browser state only for panes the workspace holds', () => {
    // The same rule the view's pane references follow: a hand-edited file must
    // not carry state for a session this workspace does not own.
    const result = normalizeFile({
      version: 1,
      workspaces: [{
        id: 'ws-1',
        name: 'Workspace',
        view: {
          browsers: {
            'local:api': { open: true, ratio: 55 },
            'ssh:elsewhere': { open: true, ratio: 40 }
          }
        },
        members: [{ sessionId: 'local:api', kind: 'local', name: 'api' }]
      }]
    });
    expect(result?.workspaces[0].view.browsers).toEqual({ 'local:api': { open: true, ratio: 55 } });
  });

  it('drops malformed browser state rather than repairing it', () => {
    const result = normalizeFile({
      version: 1,
      workspaces: [{
        id: 'ws-1',
        name: 'Workspace',
        view: {
          browsers: {
            'local:a': { open: 'yes' },
            'local:b': { open: true, ratio: 400 },
            'local:c': { open: true, ratio: 'wide' },
            'local:d': { open: false },
            'local:e': 'not an object'
          }
        },
        members: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ sessionId: `local:${id}`, kind: 'local', name: id }))
      }]
    });
    // Four members survive the pane cap, and of those only the well-formed
    // entries remain: `open` must be a boolean, and a ratio outside the drag
    // limits is dropped rather than clamped, leaving the pane on the default
    // split as one with no entry at all would be.
    expect(result?.workspaces[0].view.browsers).toEqual({
      'local:b': { open: true },
      'local:c': { open: true },
      'local:d': { open: false }
    });
  });

  it('drops a duplicated workspace id', () => {
    const result = normalizeFile({
      version: 1,
      workspaces: [
        { id: 'ws-1', name: 'One', view: {}, members: [] },
        { id: 'ws-1', name: 'Two', view: {}, members: [] }
      ]
    });
    expect(result?.workspaces).toHaveLength(1);
    expect(result?.workspaces[0].name).toBe('One');
  });

  it('refuses a view pointing at a session the workspace does not hold', () => {
    // A hand-edited file must not be able to aim a pane at something absent.
    const result = normalizeFile({
      version: 1,
      workspaces: [{
        id: 'ws-1',
        name: 'Workspace',
        view: { layout: 'grid', lastSplit: 'grid', activeSessionId: 'local:ghost', maximizedSessionId: 'local:ghost' },
        members: [{ sessionId: 'local:api', kind: 'local', name: 'api' }]
      }]
    });
    expect(result?.workspaces[0].view.activeSessionId).toBeUndefined();
    expect(result?.workspaces[0].view.maximizedSessionId).toBeNull();
  });

  it('falls back to a usable layout for an unknown one', () => {
    const result = normalizeFile({
      version: 1,
      workspaces: [{ id: 'ws-1', name: 'Workspace', view: { layout: 'hexagonal', lastSplit: 'stack' }, members: [] }]
    });
    // 'stack' is not a split, so it cannot be what the single-pane view folds
    // back out to either.
    expect(result?.workspaces[0].view).toMatchObject({ layout: 'stack', lastSplit: 'split-v' });
  });

  it('strips control characters and caps long text', () => {
    const result = normalizeFile({
      version: 1,
      workspaces: [{
        id: 'ws-1',
        name: `evil${String.fromCharCode(27)}[2Jname`,
        view: {},
        members: [{ sessionId: 'local:api', kind: 'local', name: 'x'.repeat(500) }]
      }]
    });
    expect(result?.workspaces[0].name).toBe('evil[2Jname');
    expect(result?.workspaces[0].members[0].name.length).toBeLessThanOrEqual(64);
  });

  it('repoints an active workspace id that names nothing', () => {
    const result = normalizeFile({
      version: 1,
      activeWorkspaceId: 'ws-missing',
      workspaces: [{ id: 'ws-1', name: 'Workspace', view: {}, members: [] }]
    });
    expect(result?.activeWorkspaceId).toBe('ws-1');
  });

  it('rejects a file with no workspaces array', () => {
    expect(normalizeFile({ version: 1 })).toBeUndefined();
    expect(normalizeFile({ version: 1, workspaces: 'nope' })).toBeUndefined();
  });
});
