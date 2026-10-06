import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRemoteFile, writeRemoteFile, type RemoteFileTransport } from '../src/main/remote-file';
import { EDIT_CONFLICT_MESSAGE, MAX_EDIT_BYTES } from '../src/shared/editing';
import { baseName, parentRemote } from '../src/shared/files';
import type { FileEntry } from '../src/shared/types';

/** A host held in memory, speaking the same three commands the real one does. */
function fakeHost(files: Record<string, Buffer | { kind: 'symlink'; size: number }>) {
  const store = new Map(Object.entries(files));
  const log: string[] = [];
  const uploads: string[] = [];
  const transport: RemoteFileTransport = {
    async list(_id, path = '/') {
      const entries: FileEntry[] = [];
      for (const [full, value] of store) {
        if (parentRemote(full) !== path) continue;
        if (Buffer.isBuffer(value)) entries.push({ name: baseName(full), kind: 'file', size: value.length });
        else entries.push({ name: baseName(full), kind: 'symlink', size: value.size });
      }
      return { path, entries };
    },
    async download(_id, remote, localDir) {
      log.push(`get ${remote}`);
      const value = store.get(remote);
      if (!value) throw new Error('No such file or directory');
      await writeFile(join(localDir, baseName(remote)), Buffer.isBuffer(value) ? value : Buffer.alloc(value.size, 0x61));
    },
    async putFile(_id, local, remote) {
      log.push(`put ${remote}`);
      uploads.push(local);
      store.set(remote, await readFile(local));
    }
  };
  return { transport, store, log, uploads };
}

async function leftovers(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('zerog-edit-'));
}

describe('readRemoteFile', () => {
  it('reads a file and its size', async () => {
    const host = fakeHost({ '/srv/app/.env': Buffer.from('KEY=value\n') });
    expect(await readRemoteFile(host.transport, 'sftp:1', '/srv/app/.env')).toEqual({ path: '/srv/app/.env', text: 'KEY=value\n', size: 10 });
  });

  it('keeps CRLF and multi-byte text exactly', async () => {
    const host = fakeHost({ '/a.txt': Buffer.from('café\r\n日本\r\n') });
    expect((await readRemoteFile(host.transport, 'sftp:1', '/a.txt')).text).toBe('café\r\n日本\r\n');
  });

  it('refuses a file over the limit without downloading it', async () => {
    const host = fakeHost({ '/big.txt': Buffer.alloc(MAX_EDIT_BYTES + 1, 0x61) });
    await expect(readRemoteFile(host.transport, 'sftp:1', '/big.txt')).rejects.toThrow(/1\.0 MiB/);
    expect(host.log).toEqual([]);
  });

  it('checks the real size of a symlink after fetching, since its listed size is the links own', async () => {
    const host = fakeHost({ '/link': { kind: 'symlink', size: MAX_EDIT_BYTES + 10 } });
    await expect(readRemoteFile(host.transport, 'sftp:1', '/link')).rejects.toThrow(/MiB/);
  });

  it('refuses binary and non-UTF-8 files', async () => {
    const host = fakeHost({ '/a.bin': Buffer.from([0x89, 0x00, 0x47]), '/latin.txt': Buffer.from([0x63, 0xe9]) });
    await expect(readRemoteFile(host.transport, 'sftp:1', '/a.bin')).rejects.toThrow(/binary/);
    await expect(readRemoteFile(host.transport, 'sftp:1', '/latin.txt')).rejects.toThrow(/UTF-8/);
  });

  it('says so when the file is not on the host', async () => {
    const host = fakeHost({ '/a.txt': Buffer.from('a') });
    await expect(readRemoteFile(host.transport, 'sftp:1', '/missing.txt')).rejects.toThrow(/does not exist/);
  });

  it('refuses a relative path and a name sftp cannot quote', async () => {
    const host = fakeHost({});
    await expect(readRemoteFile(host.transport, 'sftp:1', 'notes.txt')).rejects.toThrow(/absolute/);
    await expect(readRemoteFile(host.transport, 'sftp:1', '/srv/it"s.txt')).rejects.toThrow(/cannot open over SSH/);
    await expect(readRemoteFile(host.transport, 'sftp:1', '/srv/*.txt')).rejects.toThrow(/cannot open over SSH/);
  });

  it('leaves no copy of the file in the temp folder, even when the read fails', async () => {
    const before = await leftovers();
    const host = fakeHost({ '/ok.txt': Buffer.from('secret'), '/bad.bin': Buffer.from([0, 1]) });
    await readRemoteFile(host.transport, 'sftp:1', '/ok.txt');
    await expect(readRemoteFile(host.transport, 'sftp:1', '/bad.bin')).rejects.toThrow();
    expect(await leftovers()).toEqual(before);
  });
});

describe('writeRemoteFile', () => {
  it('uploads the new text over the file', async () => {
    const host = fakeHost({ '/srv/.env': Buffer.from('A=1\n') });
    const stamp = await writeRemoteFile(host.transport, 'sftp:1', '/srv/.env', 'A=2\n', 'A=1\n');
    expect(host.store.get('/srv/.env')?.toString()).toBe('A=2\n');
    expect(stamp).toEqual({ size: 4 });
  });

  it('checks the host first, so a change made meanwhile is caught by content', async () => {
    const host = fakeHost({ '/srv/.env': Buffer.from('A=agent\n') });
    await expect(writeRemoteFile(host.transport, 'sftp:1', '/srv/.env', 'A=2\n', 'A=1\n')).rejects.toThrow(EDIT_CONFLICT_MESSAGE);
    expect(host.store.get('/srv/.env')?.toString()).toBe('A=agent\n');
    expect(host.log).toEqual(['get /srv/.env']);
  });

  it('overwrites a changed file, without fetching it first, when told to', async () => {
    const host = fakeHost({ '/srv/.env': Buffer.from('A=agent\n') });
    await writeRemoteFile(host.transport, 'sftp:1', '/srv/.env', 'A=2\n', 'A=1\n', true);
    expect(host.store.get('/srv/.env')?.toString()).toBe('A=2\n');
    expect(host.log).toEqual(['put /srv/.env']);
  });

  it('saves again straight after, using what it wrote as the new opened text', async () => {
    const host = fakeHost({ '/a.txt': Buffer.from('one') });
    await writeRemoteFile(host.transport, 'sftp:1', '/a.txt', 'two', 'one');
    await writeRemoteFile(host.transport, 'sftp:1', '/a.txt', 'three', 'two');
    expect(host.store.get('/a.txt')?.toString()).toBe('three');
  });

  it('keeps CRLF text exactly as given', async () => {
    const host = fakeHost({ '/a.txt': Buffer.from('a\r\n') });
    await writeRemoteFile(host.transport, 'sftp:1', '/a.txt', 'a\r\nb\r\n', 'a\r\n');
    expect(host.store.get('/a.txt')?.toString()).toBe('a\r\nb\r\n');
  });

  it('counts bytes against the limit, and does not touch the host when over it', async () => {
    const host = fakeHost({ '/a.txt': Buffer.from('a') });
    await expect(writeRemoteFile(host.transport, 'sftp:1', '/a.txt', 'x'.repeat(MAX_EDIT_BYTES + 1), 'a')).rejects.toThrow(/more than/);
    expect(host.log).toEqual([]);
  });

  it('reports a file that has gone as gone, not as a conflict', async () => {
    const host = fakeHost({});
    await expect(writeRemoteFile(host.transport, 'sftp:1', '/gone.txt', 'x', 'x')).rejects.toThrow(/No such file/);
  });

  it('uploads from a temp file named like the target and removes it afterwards', async () => {
    const before = await leftovers();
    const host = fakeHost({ '/srv/.env': Buffer.from('A=1\n') });
    await writeRemoteFile(host.transport, 'sftp:1', '/srv/.env', 'A=2\n', 'A=1\n');
    expect(baseName(host.uploads[0])).toBe('.env');
    await expect(access(host.uploads[0])).rejects.toThrow();
    expect(await leftovers()).toEqual(before);
  });

  it('refuses a name sftp cannot quote', async () => {
    const host = fakeHost({});
    await expect(writeRemoteFile(host.transport, 'sftp:1', '/srv/a"b', 'x', 'x')).rejects.toThrow(/cannot open over SSH/);
  });
});
