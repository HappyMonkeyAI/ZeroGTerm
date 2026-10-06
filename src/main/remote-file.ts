// Reading and writing one text file on an SSH host, for the editor.
//
// sftp has no "send me the bytes" command, only get and put, so a read is a
// download to a private temp directory and a save is an upload from one. Each is
// cleaned up whatever happens: a copy of someone's `.env` left in a temp folder
// is the worst thing this module could do.
//
// A save is checked against the host the same way a local one is checked against
// the disk, but by *content*: sftp's listing times are only minute-accurate, so
// the file is fetched again and compared with what the editor opened. That costs
// a second transfer and cannot be wrong.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDIT_CONFLICT_MESSAGE, MAX_EDIT_BYTES } from '../shared/editing.js';
import { baseName, parentRemote } from '../shared/files.js';
import type { DirectoryListing, FileEntry, RemoteFileContent, RemoteFileStamp } from '../shared/types.js';
import { checkEditableSize, decodeEditable, megabytes } from './editable.js';
import { isSafeRemotePath } from './sftp-protocol.js';

/** The part of SftpService this needs, so a test can stand a fake host in for it. */
export type RemoteFileTransport = {
  list(sessionId: string, path?: string): Promise<DirectoryListing>;
  download(sessionId: string, remotePath: string, localDir: string, kind: FileEntry['kind']): Promise<void>;
  putFile(sessionId: string, localPath: string, remotePath: string): Promise<void>;
};

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  // mkdtemp makes the directory private to this user where the platform has
  // such a thing.
  const dir = await mkdtemp(join(tmpdir(), 'zerog-edit-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function requireEditablePath(path: string): void {
  if (!path.startsWith('/')) throw new Error('Only absolute remote paths can be edited.');
  if (!isSafeRemotePath(path)) {
    throw new Error('That file name has a quote, backslash, wildcard or control character in it, which this editor cannot open over SSH yet.');
  }
}

/** The file's bytes, fetched into a temp directory and read back out of it. */
async function fetch(transport: RemoteFileTransport, sessionId: string, path: string): Promise<Uint8Array> {
  return withTempDir(async (dir) => {
    await transport.download(sessionId, path, dir, 'file');
    const local = join(dir, baseName(path));
    const info = await stat(local);
    // The listing could not vouch for the size of a symlink, so the real one is
    // checked here too — after the fact, but before the bytes are read.
    checkEditableSize(info.size);
    return readFile(local);
  });
}

/**
 * Read a remote file as text, or say why it cannot be edited.
 *
 * The size is taken from a listing first, so a large file is refused before it
 * is downloaded rather than after.
 */
export async function readRemoteFile(transport: RemoteFileTransport, sessionId: string, path: string): Promise<RemoteFileContent> {
  requireEditablePath(path);
  const listing = await transport.list(sessionId, parentRemote(path));
  const entry = listing.entries.find((candidate) => candidate.name === baseName(path));
  if (!entry) throw new Error('That file does not exist on the host.');
  if (entry.kind === 'directory') throw new Error('That is not a file.');
  // A symlink's listed size is the link's own, so it is checked after the fetch.
  if (entry.kind === 'file') checkEditableSize(entry.size);
  const bytes = await fetch(transport, sessionId, path);
  return { path, text: decodeEditable(bytes), size: bytes.length };
}

/**
 * Save the editor's text to a remote file.
 *
 * `opened` is the exact text the editor read, and the save is refused if the host
 * now holds something else. `overwrite` is the user saying they have seen that.
 *
 * The upload is a plain `put` with no `-p`: that leaves an existing file's
 * permissions alone, where preserving the temp file's would reset them — a
 * `.env` that was 600 must not come back world-readable.
 */
export async function writeRemoteFile(
  transport: RemoteFileTransport,
  sessionId: string,
  path: string,
  text: string,
  opened: string,
  overwrite = false
): Promise<RemoteFileStamp> {
  requireEditablePath(path);
  if (Buffer.byteLength(text, 'utf8') > MAX_EDIT_BYTES) {
    throw new Error(`That is more than ${megabytes(MAX_EDIT_BYTES)}, which is more than the editor saves.`);
  }
  if (!overwrite) {
    // Not the same failure as "changed": a file that has gone is reported as
    // gone, by the transfer's own error, rather than as a conflict.
    const now = decodeEditable(await fetch(transport, sessionId, path));
    if (now !== opened) throw new Error(EDIT_CONFLICT_MESSAGE);
  }
  await withTempDir(async (dir) => {
    const local = join(dir, baseName(path));
    await writeFile(local, text, 'utf8');
    await transport.putFile(sessionId, local, path);
  });
  return { size: Buffer.byteLength(text, 'utf8') };
}
