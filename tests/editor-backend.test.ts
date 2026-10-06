import { describe, expect, it, vi } from 'vitest';
import { localBackend, remoteBackend } from '../src/renderer/editor-backend';

describe('localBackend', () => {
  it('reads a file with its modified time as the version', async () => {
    const backend = localBackend({
      readLocalFile: async (path) => ({ path, text: 'A=1\n', size: 4, mtimeMs: 1234 }),
      writeLocalFile: async () => ({ size: 0, mtimeMs: 0 })
    });
    expect(await backend.read('/home/me/.env')).toEqual({ path: '/home/me/.env', text: 'A=1\n', version: 1234 });
  });

  it('saves against the version it was opened with, and returns the new one', async () => {
    const write = vi.fn(async () => ({ size: 4, mtimeMs: 5678 }));
    const backend = localBackend({ readLocalFile: async () => ({ path: '', text: '', size: 0, mtimeMs: 0 }), writeLocalFile: write });
    expect(await backend.write('/a', 'x', 1234, false)).toBe(5678);
    expect(write).toHaveBeenCalledWith('/a', 'x', 1234, false);
  });

  it('refuses a version that did not come from a local file', async () => {
    const backend = localBackend({ readLocalFile: async () => ({ path: '', text: '', size: 0, mtimeMs: 0 }), writeLocalFile: async () => ({ size: 0, mtimeMs: 0 }) });
    await expect(backend.write('/a', 'x', 'text', false)).rejects.toThrow(/not opened from this machine/);
  });
});

describe('remoteBackend', () => {
  const handle = async <T>(run: (handle: string) => Promise<T>) => run('sftp-1');

  it('reads a file with its own text as the version', async () => {
    const backend = remoteBackend(
      { sftpReadFile: async (id, path) => ({ path: `${id}:${path}`, text: 'A=1\n', size: 4 }), sftpWriteFile: async () => ({ size: 0 }) },
      handle
    );
    expect(await backend.read('/srv/.env')).toEqual({ path: 'sftp-1:/srv/.env', text: 'A=1\n', version: 'A=1\n' });
  });

  it('saves against the text it was opened with, and returns what it wrote as the new version', async () => {
    const write = vi.fn(async () => ({ size: 4 }));
    const backend = remoteBackend({ sftpReadFile: async () => ({ path: '', text: '', size: 0 }), sftpWriteFile: write }, handle);
    expect(await backend.write('/srv/.env', 'A=2\n', 'A=1\n', true)).toBe('A=2\n');
    expect(write).toHaveBeenCalledWith('sftp-1', '/srv/.env', 'A=2\n', 'A=1\n', true);
  });

  it('refuses a version that did not come from a remote file', async () => {
    const backend = remoteBackend({ sftpReadFile: async () => ({ path: '', text: '', size: 0 }), sftpWriteFile: async () => ({ size: 0 }) }, handle);
    await expect(backend.write('/a', 'x', 1234, false)).rejects.toThrow(/not opened from this host/);
  });

  it('goes through the connection supplier for both, so a closed one is revived', async () => {
    const calls: string[] = [];
    const supplier = async <T>(run: (handle: string) => Promise<T>) => {
      calls.push('handle');
      return run('sftp-2');
    };
    const backend = remoteBackend(
      { sftpReadFile: async () => ({ path: '/a', text: 'a', size: 1 }), sftpWriteFile: async () => ({ size: 1 }) },
      supplier
    );
    await backend.read('/a');
    await backend.write('/a', 'b', 'a', false);
    expect(calls).toEqual(['handle', 'handle']);
  });
});
