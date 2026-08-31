import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PortForwardStore, defaultPortForwardPath, forgetStatus, normalizeFile } from '../src/main/port-forward-store';
import type { PortForwardInfo, StoredPortForwardFile } from '../src/shared/types';

async function file() {
  return join(await mkdtemp(join(tmpdir(), 'zerog-forwards-')), 'port-forwards.json');
}

const saved: StoredPortForwardFile = {
  version: 1,
  forwards: [
    { id: 'forward:1', target: 'dev@build.example.com', direction: 'local', listenPort: 3000, destinationPort: 3000, bind: 'loopback' },
    { id: 'forward:2', target: 'db.example.com', direction: 'local', listenPort: 5432, destinationPort: 5432, bind: 'all', destinationHost: 'db.internal' },
    { id: 'forward:3', target: 'dev@build.example.com', direction: 'remote', listenPort: 8080, destinationPort: 4000, bind: 'loopback' }
  ]
};

describe('port forward store', () => {
  it('round trips what was shared', async () => {
    const path = await file();
    await new PortForwardStore({ filePath: path }).save(saved);
    expect(await new PortForwardStore({ filePath: path }).load()).toEqual(saved);
  });

  it('starts empty when there is no file yet', async () => {
    expect(await new PortForwardStore({ filePath: await file() }).load()).toEqual({ version: 1, forwards: [] });
  });

  it('tolerates a malformed file', async () => {
    const path = await file();
    await writeFile(path, '{not json');
    expect(await new PortForwardStore({ filePath: path }).load()).toEqual({ version: 1, forwards: [] });
  });

  it('ignores a file from a future schema version', async () => {
    const path = await file();
    await writeFile(path, JSON.stringify({ ...saved, version: 99 }));
    expect(await new PortForwardStore({ filePath: path }).load()).toEqual({ version: 1, forwards: [] });
  });

  it('never writes a status, which is not a fact about tomorrow', async () => {
    const path = await file();
    const live: PortForwardInfo = {
      id: 'forward:1',
      target: 'dev@build.example.com',
      direction: 'local',
      listenPort: 3000,
      destinationPort: 3000,
      bind: 'loopback',
      status: 'open',
      message: 'listening'
    };
    await new PortForwardStore({ filePath: path }).save({ version: 1, forwards: [forgetStatus(live)] });
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('status');
    expect(text).not.toContain('listening');
  });

  it('rejects a save it could not make sense of', async () => {
    const store = new PortForwardStore({ filePath: await file() });
    await expect(store.save({ version: 1 })).rejects.toThrow(/Invalid shared port list/);
    await expect(store.save(null)).rejects.toThrow(/Invalid shared port list/);
  });

  it('keeps the last good list when a bad save is refused', async () => {
    const path = await file();
    const store = new PortForwardStore({ filePath: path });
    await store.save(saved);
    await expect(store.save('nonsense')).rejects.toThrow();
    expect((await new PortForwardStore({ filePath: path }).load()).forwards).toHaveLength(3);
  });

  it('serialises concurrent saves', async () => {
    const path = await file();
    const store = new PortForwardStore({ filePath: path });
    await Promise.all([store.save(saved), store.save({ version: 1, forwards: [] }), store.save(saved)]);
    const loaded = await new PortForwardStore({ filePath: path }).load();
    expect(loaded.version).toBe(1);
    expect(Array.isArray(loaded.forwards)).toBe(true);
  });

  it('names the file beside the other main-process state', () => {
    expect(defaultPortForwardPath(join('/tmp', 'userData'))).toBe(join('/tmp', 'userData', 'port-forwards.json'));
  });
});

describe('normalizeFile', () => {
  const one = (overrides: Record<string, unknown>) =>
    normalizeFile({ version: 1, forwards: [{ id: 'f', target: 'host', direction: 'local', listenPort: 1, destinationPort: 2, bind: 'loopback', ...overrides }] })
      ?.forwards[0];

  it('never widens a forward a truncated file did not describe', () => {
    // The whole point of loopback-by-default is that a wide bind is chosen, so a
    // missing or unrecognised value must land on the safe side.
    expect(one({ bind: undefined })?.bind).toBe('loopback');
    expect(one({ bind: 'everywhere' })?.bind).toBe('loopback');
    expect(one({ bind: true })?.bind).toBe('loopback');
    expect(one({ bind: 'all' })?.bind).toBe('all');
  });

  it('drops a forward with an unusable port', () => {
    expect(one({ listenPort: 0 })).toBeUndefined();
    expect(one({ listenPort: 65536 })).toBeUndefined();
    expect(one({ destinationPort: 'https' })).toBeUndefined();
    expect(one({ listenPort: 8080.5 })).toBeUndefined();
  });

  it('drops a forward missing an id, target, or direction', () => {
    expect(one({ id: '' })).toBeUndefined();
    expect(one({ target: undefined })).toBeUndefined();
    expect(one({ direction: 'sideways' })).toBeUndefined();
  });

  it('leaves the destination host off rather than storing an empty one', () => {
    // An empty string reaching the forward spec would build a different tunnel;
    // absent means the protocol's own default applies.
    expect(one({ destinationHost: '' })).not.toHaveProperty('destinationHost');
    expect(one({ destinationHost: 42 })).not.toHaveProperty('destinationHost');
    expect(one({ destinationHost: 'db.internal' })?.destinationHost).toBe('db.internal');
  });

  it('strips control characters and caps long text', () => {
    const forward = one({ id: `f${String.fromCharCode(27)}[2J`, target: 'h'.repeat(400) });
    expect(forward?.id).toBe('f[2J');
    expect(forward?.target.length).toBeLessThanOrEqual(256);
  });

  it('drops a duplicated id', () => {
    const result = normalizeFile({
      version: 1,
      forwards: [
        { id: 'f', target: 'a', direction: 'local', listenPort: 1, destinationPort: 1, bind: 'loopback' },
        { id: 'f', target: 'b', direction: 'local', listenPort: 2, destinationPort: 2, bind: 'loopback' }
      ]
    });
    expect(result?.forwards).toHaveLength(1);
    expect(result?.forwards[0].target).toBe('a');
  });

  it('rejects a file with no forwards array', () => {
    expect(normalizeFile({ version: 1 })).toBeUndefined();
    expect(normalizeFile({ version: 1, forwards: 'nope' })).toBeUndefined();
    expect(normalizeFile(undefined)).toBeUndefined();
  });
});
