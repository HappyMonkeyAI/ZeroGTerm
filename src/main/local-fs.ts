// The local half of the transfer panel: directory listings and the three edits
// the panel can make locally.
//
// Nothing here reads file *contents*. The renderer is sandboxed and has no
// filesystem access of its own, and this module is deliberately the narrowest
// widening of that boundary that a file browser needs: names, sizes, kinds, and
// explicit create/rename/delete on a path the user pointed at.

import { constants } from 'node:fs';
import { access, lstat, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { DirectoryListing, FileEntry } from '../shared/types.js';
import { sortEntries } from '../shared/files.js';

/**
 * A path this process will act on.
 *
 * Paths arrive from the renderer, so they are re-derived here rather than
 * trusted: NUL terminates the path for the C library underneath and can make a
 * check and the later operation disagree about which file is meant, and a
 * relative path would resolve against whatever directory the app happens to
 * have — never something the user chose.
 */
export function resolveLocalPath(input: unknown): string {
  if (typeof input !== 'string' || !input) throw new Error('A filesystem path is required.');
  if (input.includes('\0')) throw new Error('That path is not valid.');
  if (input.length > 4096) throw new Error('That path is too long.');
  const expanded = input === '~' || input.startsWith('~/') || input.startsWith('~\\')
    ? join(homedir(), input.slice(1))
    : input;
  if (!isAbsolute(expanded)) throw new Error('Only absolute paths can be browsed.');
  return resolve(normalize(expanded));
}

export function localHome(): string {
  return homedir();
}

/**
 * List a directory.
 *
 * A stat per entry is what makes kind and size real, and it is allowed to fail:
 * a broken symlink or a file that has just been deleted should leave a row in
 * the listing rather than emptying the pane.
 */
export async function listLocalDirectory(path?: string): Promise<DirectoryListing> {
  const target = path ? resolveLocalPath(path) : homedir();
  await access(target, constants.R_OK);
  const dirents = await readdir(target, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent): Promise<FileEntry> => {
      const full = join(target, dirent.name);
      const link = dirent.isSymbolicLink();
      try {
        // Symlinks are stat'd through, so a link to a directory can be entered,
        // while still being labelled as a link.
        const info = link ? await stat(full) : await lstat(full);
        return {
          name: dirent.name,
          kind: info.isDirectory() ? 'directory' : link ? 'symlink' : 'file',
          size: info.size,
          modified: info.mtime.toISOString()
        };
      } catch {
        return { name: dirent.name, kind: link ? 'symlink' : dirent.isDirectory() ? 'directory' : 'file', size: 0 };
      }
    })
  );
  return { path: target, entries: sortEntries(entries) };
}

export async function createLocalDirectory(path: string): Promise<void> {
  // No recursive create: the panel creates one folder in the directory on
  // screen, and a mistyped path should fail rather than build a tree.
  await mkdir(resolveLocalPath(path));
}

export async function renameLocalEntry(from: string, to: string): Promise<void> {
  const source = resolveLocalPath(from);
  const destination = resolveLocalPath(to);
  // rename() would silently replace an existing file; the panel's rename is a
  // relabel, never an overwrite.
  const clash = await lstat(destination).then(() => true, () => false);
  if (clash) throw new Error('Something with that name already exists here.');
  await rename(source, destination);
}

/**
 * Delete one entry.
 *
 * Directories use rmdir, so a non-empty one fails: this panel deletes what the
 * user pointed at, and a recursive local delete triggered by a single click is
 * not a mistake worth making possible.
 */
export async function removeLocalEntry(path: string, kind: FileEntry['kind']): Promise<void> {
  const target = resolveLocalPath(path);
  if (target === resolve(homedir())) throw new Error('Refusing to delete the home directory.');
  if (kind === 'directory') await rmdir(target);
  else await rm(target, { force: false });
}
