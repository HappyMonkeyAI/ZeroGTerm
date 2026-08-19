import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalDirectory, listLocalDirectory, localHome, removeLocalEntry, renameLocalEntry, resolveLocalPath } from '../src/main/local-fs';

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'zerog-fs-'));
  await mkdir(join(root, 'build'));
  await writeFile(join(root, 'notes.md'), 'hello');
  await writeFile(join(root, 'release notes.md'), 'spaces are ordinary');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('local paths crossing the IPC boundary', () => {
  it('accepts an absolute path and expands the home shorthand', () => {
    expect(resolveLocalPath(root)).toBe(root);
    expect(resolveLocalPath('~')).toBe(resolveLocalPath(homedir()));
  });

  it('refuses what could name a different file than it appears to', () => {
    // NUL truncates the path for the C library underneath, so a check and the
    // operation that follows it could disagree about which file is meant.
    expect(() => resolveLocalPath('/tmp/safe\0/../../etc/passwd')).toThrow();
    expect(() => resolveLocalPath('relative/path')).toThrow();
    expect(() => resolveLocalPath('')).toThrow();
    expect(() => resolveLocalPath(42)).toThrow();
  });

  it('reports a home directory to start the panel in', () => {
    expect(localHome()).toBe(homedir());
  });
});

describe('local listings', () => {
  it('lists a folder with directories first', async () => {
    const listing = await listLocalDirectory(root);
    expect(listing.path).toBe(root);
    expect(listing.entries.map((entry) => entry.name)).toEqual(['build', 'notes.md', 'release notes.md']);
    expect(listing.entries[0].kind).toBe('directory');
    expect(listing.entries[1]).toMatchObject({ kind: 'file', size: 5 });
    // An ISO timestamp, so the renderer formats it rather than parsing prose.
    expect(listing.entries[1].modified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports an unreadable folder rather than an empty one', async () => {
    await expect(listLocalDirectory(join(root, 'does-not-exist'))).rejects.toThrow();
  });
});

describe('local edits the panel can make', () => {
  it('creates one folder, not a tree', async () => {
    await createLocalDirectory(join(root, 'made'));
    const listing = await listLocalDirectory(root);
    expect(listing.entries.some((entry) => entry.name === 'made')).toBe(true);
    // A mistyped path is a mistake to report, not a tree to build.
    await expect(createLocalDirectory(join(root, 'a', 'b', 'c'))).rejects.toThrow();
  });

  it('renames without overwriting whatever is already there', async () => {
    await writeFile(join(root, 'first.txt'), 'one');
    await writeFile(join(root, 'second.txt'), 'two');
    await expect(renameLocalEntry(join(root, 'first.txt'), join(root, 'second.txt'))).rejects.toThrow(/already exists/);
    await renameLocalEntry(join(root, 'first.txt'), join(root, 'third.txt'));
    const listing = await listLocalDirectory(root);
    const names = listing.entries.map((entry) => entry.name);
    expect(names).toContain('third.txt');
    expect(names).not.toContain('first.txt');
  });

  it('deletes what was pointed at, and refuses a non-empty folder', async () => {
    await writeFile(join(root, 'build', 'kept.txt'), 'x');
    await expect(removeLocalEntry(join(root, 'build'), 'directory')).rejects.toThrow();
    await removeLocalEntry(join(root, 'build', 'kept.txt'), 'file');
    await removeLocalEntry(join(root, 'build'), 'directory');
    const listing = await listLocalDirectory(root);
    expect(listing.entries.some((entry) => entry.name === 'build')).toBe(false);
  });

  it('will not delete the home directory', async () => {
    await expect(removeLocalEntry(homedir(), 'directory')).rejects.toThrow(/home directory/);
  });
});
