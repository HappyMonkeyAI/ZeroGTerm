import { mkdir, mkdtemp, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLocalFile, writeLocalFile } from '../src/main/local-fs';
import { EDIT_CONFLICT_MESSAGE, MAX_EDIT_BYTES } from '../src/shared/editing';

async function dir() {
  return mkdtemp(join(tmpdir(), 'zerog-edit-'));
}

describe('readLocalFile', () => {
  it('reads text and says when it was last changed', async () => {
    const path = join(await dir(), '.env');
    await writeFile(path, 'KEY=value\n');
    const file = await readLocalFile(path);
    expect(file.text).toBe('KEY=value\n');
    expect(file.size).toBe(10);
    expect(file.mtimeMs).toBe((await stat(path)).mtimeMs);
  });

  it('keeps multi-byte text and a byte order mark exactly', async () => {
    const path = join(await dir(), 'a.txt');
    await writeFile(path, '﻿café — 日本語\r\n');
    expect((await readLocalFile(path)).text).toBe('﻿café — 日本語\r\n');
  });

  it('opens an empty file', async () => {
    const path = join(await dir(), 'empty');
    await writeFile(path, '');
    expect((await readLocalFile(path)).text).toBe('');
  });

  it('refuses a binary file', async () => {
    const path = join(await dir(), 'a.bin');
    await writeFile(path, Buffer.from([0x89, 0x50, 0x00, 0x47]));
    await expect(readLocalFile(path)).rejects.toThrow(/binary/);
  });

  it('refuses text that is not valid UTF-8 rather than mangling it', async () => {
    const path = join(await dir(), 'latin1.txt');
    await writeFile(path, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await expect(readLocalFile(path)).rejects.toThrow(/UTF-8/);
  });

  it('refuses a file over the size limit and says how big it is', async () => {
    const path = join(await dir(), 'big.txt');
    await writeFile(path, 'x'.repeat(MAX_EDIT_BYTES + 1));
    await expect(readLocalFile(path)).rejects.toThrow(/1\.0 MiB/);
  });

  it('opens a file exactly at the limit', async () => {
    const path = join(await dir(), 'edge.txt');
    await writeFile(path, 'x'.repeat(MAX_EDIT_BYTES));
    expect((await readLocalFile(path)).size).toBe(MAX_EDIT_BYTES);
  });

  it('refuses a directory', async () => {
    await expect(readLocalFile(await dir())).rejects.toThrow(/not a file/);
  });

  it('fails on a file that is not there', async () => {
    await expect(readLocalFile(join(await dir(), 'missing'))).rejects.toThrow();
  });

  it('refuses a relative path and a NUL byte, like every other local path', async () => {
    await expect(readLocalFile('notes.txt')).rejects.toThrow(/absolute/);
    await expect(readLocalFile('/tmp/a\0b')).rejects.toThrow(/not valid/);
  });
});

describe('writeLocalFile', () => {
  it('saves over the file and returns its new stamp', async () => {
    const path = join(await dir(), '.env');
    await writeFile(path, 'A=1\n');
    const opened = await readLocalFile(path);
    const stamp = await writeLocalFile(path, 'A=2\n', opened.mtimeMs);
    expect(await readFile(path, 'utf8')).toBe('A=2\n');
    expect(stamp.size).toBe(4);
    expect(stamp.mtimeMs).toBe((await stat(path)).mtimeMs);
  });

  it('can save again straight after, using the stamp it returned', async () => {
    const path = join(await dir(), 'a.txt');
    await writeFile(path, 'one');
    const opened = await readLocalFile(path);
    const first = await writeLocalFile(path, 'two', opened.mtimeMs);
    await writeLocalFile(path, 'three', first.mtimeMs);
    expect(await readFile(path, 'utf8')).toBe('three');
  });

  it('refuses when the file changed after it was opened, and leaves it alone', async () => {
    const path = join(await dir(), '.env');
    await writeFile(path, 'A=1\n');
    const opened = await readLocalFile(path);
    await writeFile(path, 'A=agent\n');
    // Some filesystems keep a coarse clock; make the change unmistakable.
    await utimes(path, new Date(), new Date(opened.mtimeMs + 5000));
    await expect(writeLocalFile(path, 'A=2\n', opened.mtimeMs)).rejects.toThrow(EDIT_CONFLICT_MESSAGE);
    expect(await readFile(path, 'utf8')).toBe('A=agent\n');
  });

  it('overwrites a changed file when told to', async () => {
    const path = join(await dir(), '.env');
    await writeFile(path, 'A=1\n');
    const opened = await readLocalFile(path);
    await utimes(path, new Date(), new Date(opened.mtimeMs + 5000));
    await writeLocalFile(path, 'A=2\n', opened.mtimeMs, true);
    expect(await readFile(path, 'utf8')).toBe('A=2\n');
  });

  it('will not recreate a file that was deleted meanwhile', async () => {
    const folder = await dir();
    const path = join(folder, 'gone.txt');
    await expect(writeLocalFile(path, 'x', 0)).rejects.toThrow(/no longer exists/);
    await expect(stat(path)).rejects.toThrow();
  });

  it('refuses text over the size limit', async () => {
    const path = join(await dir(), 'a.txt');
    await writeFile(path, 'a');
    const opened = await readLocalFile(path);
    await expect(writeLocalFile(path, 'x'.repeat(MAX_EDIT_BYTES + 1), opened.mtimeMs)).rejects.toThrow(/more than/);
    expect(await readFile(path, 'utf8')).toBe('a');
  });

  it('refuses a directory', async () => {
    const folder = await dir();
    await mkdir(join(folder, 'sub'));
    await expect(writeLocalFile(join(folder, 'sub'), 'x', 0)).rejects.toThrow(/not a file/);
  });

  it('writes through a symlink instead of replacing it', async () => {
    const folder = await dir();
    const real = join(folder, 'real.txt');
    const link = join(folder, 'link.txt');
    await writeFile(real, 'before');
    try {
      await symlink(real, link);
    } catch {
      // Creating a symlink needs a privilege some Windows setups do not grant.
      return;
    }
    const opened = await readLocalFile(link);
    await writeLocalFile(link, 'after', opened.mtimeMs);
    expect(await readFile(real, 'utf8')).toBe('after');
  });
});
