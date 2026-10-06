// The local half of the transfer panel: directory listings and the three edits
// the panel can make locally, plus reading and writing one text file for the
// built-in editor.
//
// The renderer is sandboxed and has no filesystem access of its own, and this
// module is deliberately the narrowest widening of that boundary that a file
// browser needs: names, sizes, kinds, and explicit create/rename/delete on a path
// the user pointed at. File *contents* are only ever read or written by the
// editor's two functions at the bottom, one file at a time, with limits.

import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { DirectoryListing, FileEntry, LocalFileContent, LocalFileStamp } from '../shared/types.js';
import { EDIT_CONFLICT_MESSAGE, MAX_EDIT_BYTES } from '../shared/editing.js';
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
 *
 * Entries are stat'd with lstat, so a symlink is reported as a symlink whatever
 * it points at. Reporting a link to a directory as a directory instead would be
 * a lie with consequences: deleting it would use `rmdir`, which refuses a
 * symlink, so the row could not be removed at all. It also matches what the
 * remote side shows, since `ls -l` describes the link rather than its target.
 * Entering one still works — see isNavigable — because opening it simply reads
 * through, and a link to a file reports that it is not a directory.
 */
export async function listLocalDirectory(path?: string): Promise<DirectoryListing> {
  const target = path ? resolveLocalPath(path) : homedir();
  await access(target, constants.R_OK);
  const dirents = await readdir(target, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent): Promise<FileEntry> => {
      const full = join(target, dirent.name);
      try {
        const info = await lstat(full);
        return {
          name: dirent.name,
          kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
          size: info.size,
          modified: info.mtime.toISOString()
        };
      } catch {
        return { name: dirent.name, kind: dirent.isSymbolicLink() ? 'symlink' : dirent.isDirectory() ? 'directory' : 'file', size: 0 };
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

/**
 * Rename an entry, refusing to land on a name that is already taken.
 *
 * rename() would silently replace an existing file, and the panel's rename is a
 * relabel rather than an overwrite. The check is not atomic: nothing in Node's
 * API offers a no-clobber rename on both platforms, so a different process that
 * creates that name in the moment between the check and the rename would still
 * be overwritten. That is a guard against the user's own mistake — the name is
 * already in the folder they are looking at — not a guarantee against another
 * writer, and anything able to win that race could equally overwrite the file
 * directly.
 */
export async function renameLocalEntry(from: string, to: string): Promise<void> {
  const source = resolveLocalPath(from);
  const destination = resolveLocalPath(to);
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

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Read one file as text for the editor, or say why it cannot be edited.
 *
 * Refused rather than coaxed: a file past the size limit, one with a NUL byte
 * (the usual mark of a binary), and one that is not valid UTF-8 would each be
 * damaged by a round trip through a text box, and a refused open costs nothing
 * where a corrupted save does. The BOM is kept as a character so a save writes it
 * back.
 *
 * Follows a symlink, as opening it in any editor would.
 */
export async function readLocalFile(path: string): Promise<LocalFileContent> {
  const target = resolveLocalPath(path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error('That is not a file.');
  if (info.size > MAX_EDIT_BYTES) {
    throw new Error(`That file is ${megabytes(info.size)}; the editor opens files up to ${megabytes(MAX_EDIT_BYTES)}.`);
  }
  const bytes = await readFile(target);
  if (bytes.includes(0)) throw new Error('That looks like a binary file, so it was not opened.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('That file is not valid UTF-8, so it was not opened.');
  }
  return { path: target, text, size: bytes.length, mtimeMs: info.mtimeMs };
}

/**
 * Save the editor's text back over the file it came from.
 *
 * Refused when the file's modified time is not the one it was opened with, so a
 * change made meanwhile — an agent writing the same `.env` in the pane behind —
 * is flagged instead of silently lost. `overwrite` is the user saying they have
 * seen that and mean it.
 *
 * Written in place rather than through a temp file and a rename, which would
 * replace a symlink with a plain file and reset the file's owner and mode. The
 * price is that a write interrupted halfway leaves a short file, which for the
 * small text files this opens is the lesser harm.
 */
export async function writeLocalFile(
  path: string,
  text: string,
  expectedMtimeMs: number,
  overwrite = false
): Promise<LocalFileStamp> {
  const target = resolveLocalPath(path);
  if (typeof text !== 'string') throw new Error('There is no text to save.');
  if (Buffer.byteLength(text, 'utf8') > MAX_EDIT_BYTES) {
    throw new Error(`That is more than ${megabytes(MAX_EDIT_BYTES)}, which is more than the editor saves.`);
  }
  const current = await stat(target).then(
    (info) => info,
    () => undefined
  );
  if (!current) throw new Error('That file no longer exists, so it was not saved.');
  if (!current.isFile()) throw new Error('That is not a file.');
  if (!overwrite && current.mtimeMs !== expectedMtimeMs) throw new Error(EDIT_CONFLICT_MESSAGE);
  await writeFile(target, text, 'utf8');
  const saved = await stat(target);
  return { size: saved.size, mtimeMs: saved.mtimeMs };
}
