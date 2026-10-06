import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostLabelStore, defaultHostLabelPath, normalizeFile } from '../src/main/host-label-store';
import { EMPTY_HOST_LABELS, hostLabelKey, labelFor, withLabel } from '../src/renderer/host-labels';
import type { StoredHostLabelFile } from '../src/shared/types';

async function file() {
  return join(await mkdtemp(join(tmpdir(), 'zerog-hostlabels-')), 'host-labels.json');
}

const saved: StoredHostLabelFile = {
  version: 1,
  hosts: [
    { host: '10.0.0.5', label: 'dev server' },
    { host: 'web.example.com', label: 'web server' }
  ]
};

describe('host label store', () => {
  it('round trips what was remembered', async () => {
    const path = await file();
    await new HostLabelStore({ filePath: path }).save(saved);
    expect(await new HostLabelStore({ filePath: path }).load()).toEqual(saved);
  });

  it('starts empty when there is no file yet', async () => {
    expect(await new HostLabelStore({ filePath: await file() }).load()).toEqual({ version: 1, hosts: [] });
  });

  it('tolerates a malformed file', async () => {
    const path = await file();
    await writeFile(path, '{not json');
    expect(await new HostLabelStore({ filePath: path }).load()).toEqual({ version: 1, hosts: [] });
  });

  it('ignores a file from a future schema version', async () => {
    const path = await file();
    await writeFile(path, JSON.stringify({ ...saved, version: 99 }));
    expect(await new HostLabelStore({ filePath: path }).load()).toEqual({ version: 1, hosts: [] });
  });

  it('rejects a save it could not make sense of and keeps the last good list', async () => {
    const path = await file();
    const store = new HostLabelStore({ filePath: path });
    await store.save(saved);
    await expect(store.save({ version: 1 })).rejects.toThrow(/Invalid host label list/);
    await expect(store.save(null)).rejects.toThrow(/Invalid host label list/);
    expect((await new HostLabelStore({ filePath: path }).load()).hosts).toHaveLength(2);
  });

  it('stores only a host and a label', async () => {
    const path = await file();
    await new HostLabelStore({ filePath: path }).save({ version: 1, hosts: [{ host: 'h', label: 'l', user: 'root', password: 'x' } as never] });
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('root');
    expect(text).not.toContain('password');
  });

  it('serialises concurrent saves', async () => {
    const path = await file();
    const store = new HostLabelStore({ filePath: path });
    await Promise.all([store.save(saved), store.save(EMPTY_HOST_LABELS), store.save(saved)]);
    const loaded = await new HostLabelStore({ filePath: path }).load();
    expect(loaded.version).toBe(1);
    expect(Array.isArray(loaded.hosts)).toBe(true);
  });

  it('names the file beside the other main-process state', () => {
    expect(defaultHostLabelPath(join('/tmp', 'userData'))).toBe(join('/tmp', 'userData', 'host-labels.json'));
  });
});

describe('normalizeFile', () => {
  const one = (overrides: Record<string, unknown>) =>
    normalizeFile({ version: 1, hosts: [{ host: 'Host', label: 'label', ...overrides }] })?.hosts[0];

  it('lowercases the host', () => {
    expect(one({})?.host).toBe('host');
  });

  it('drops an entry with no usable host or label', () => {
    expect(one({ host: '' })).toBeUndefined();
    expect(one({ label: '   ' })).toBeUndefined();
    expect(one({ host: 5 })).toBeUndefined();
    expect(one({ label: undefined })).toBeUndefined();
  });

  it('strips control characters and caps long text', () => {
    const entry = one({ label: `a${String.fromCharCode(27)}[2J${'x'.repeat(100)}` });
    expect(entry?.label).not.toContain(String.fromCharCode(27));
    expect(entry?.label.length).toBeLessThanOrEqual(48);
  });

  it('keeps the last word when a host is repeated', () => {
    const result = normalizeFile({
      version: 1,
      hosts: [
        { host: 'a', label: 'first' },
        { host: 'b', label: 'other' },
        { host: 'A', label: 'second' }
      ]
    });
    expect(result?.hosts).toEqual([
      { host: 'b', label: 'other' },
      { host: 'a', label: 'second' }
    ]);
  });

  it('drops the oldest hosts past the cap', () => {
    const hosts = Array.from({ length: 300 }, (_, index) => ({ host: `h${index}`, label: 'l' }));
    const result = normalizeFile({ version: 1, hosts });
    expect(result?.hosts).toHaveLength(256);
    expect(result?.hosts[0].host).toBe('h44');
    expect(result?.hosts[255].host).toBe('h299');
  });

  it('rejects a file with no hosts array', () => {
    expect(normalizeFile({ version: 1 })).toBeUndefined();
    expect(normalizeFile({ version: 1, hosts: 'nope' })).toBeUndefined();
    expect(normalizeFile(undefined)).toBeUndefined();
  });
});

describe('host label lookups', () => {
  it('keys on the bare lowercase host', () => {
    expect(hostLabelKey('dev@Build.Example.com:2222')).toBe('build.example.com');
    expect(hostLabelKey('  10.0.0.5 ')).toBe('10.0.0.5');
    expect(hostLabelKey('')).toBe('');
  });

  it('finds a label whatever user or port the target carries', () => {
    expect(labelFor(saved, '10.0.0.5')).toBe('dev server');
    expect(labelFor(saved, 'root@10.0.0.5:2222')).toBe('dev server');
    expect(labelFor(saved, 'WEB.example.com')).toBe('web server');
  });

  it('finds nothing for an unknown or empty target', () => {
    expect(labelFor(saved, '10.0.0.9')).toBeUndefined();
    expect(labelFor(saved, '')).toBeUndefined();
  });

  it('records a new label and replaces an old one', () => {
    const added = withLabel(EMPTY_HOST_LABELS, 'me@box:22', 'build box');
    expect(added.hosts).toEqual([{ host: 'box', label: 'build box' }]);
    const replaced = withLabel(added, 'box', 'ci box');
    expect(replaced.hosts).toEqual([{ host: 'box', label: 'ci box' }]);
  });

  it('keeps the old label when the new one is blank', () => {
    expect(withLabel(saved, '10.0.0.5', '   ')).toBe(saved);
    expect(withLabel(saved, '', 'x')).toBe(saved);
  });

  it('moves a reused host to the end so the cap drops the one unused longest', () => {
    const result = withLabel(saved, '10.0.0.5', 'dev server');
    expect(result.hosts.map((entry) => entry.host)).toEqual(['web.example.com', '10.0.0.5']);
  });

  it('leaves the file untouched when nothing changed', () => {
    const latest = withLabel(saved, 'web.example.com', 'web server');
    expect(withLabel(latest, 'web.example.com', 'web server')).toBe(latest);
  });
});
