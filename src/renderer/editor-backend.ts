// Where the editor's files live.
//
// The overlay reads and saves through this and never learns whether the file is
// on this machine or on an SSH host. The one thing the two differ in is how a
// save notices that the file changed underneath it, which is hidden in
// `version`: the modified time for a local file, the exact text that was opened
// for a remote one (sftp's own times are too coarse to trust).

import type { LocalFileContent, LocalFileStamp, RemoteFileContent, RemoteFileStamp } from '../shared/types';

/** What identifies the file as it was opened, handed back unchanged on save. */
export type FileVersion = string | number;

export type EditorFile = {
  path: string;
  /** Exactly as stored, line endings included. */
  text: string;
  version: FileVersion;
};

export type EditorBackend = {
  read(path: string): Promise<EditorFile>;
  /** Resolves to the version the file now has, for the next save to be checked against. */
  write(path: string, text: string, version: FileVersion, overwrite: boolean): Promise<FileVersion>;
};

export type LocalEditApi = {
  readLocalFile(path: string): Promise<LocalFileContent>;
  writeLocalFile(path: string, text: string, expectedMtimeMs: number, overwrite?: boolean): Promise<LocalFileStamp>;
};

export type RemoteEditApi = {
  sftpReadFile(sessionId: string, path: string): Promise<RemoteFileContent>;
  sftpWriteFile(sessionId: string, path: string, text: string, opened: string, overwrite?: boolean): Promise<RemoteFileStamp>;
};

export function localBackend(api: LocalEditApi): EditorBackend {
  return {
    async read(path) {
      const file = await api.readLocalFile(path);
      return { path: file.path, text: file.text, version: file.mtimeMs };
    },
    async write(path, text, version, overwrite) {
      if (typeof version !== 'number') throw new Error('That file was not opened from this machine.');
      return (await api.writeLocalFile(path, text, version, overwrite)).mtimeMs;
    }
  };
}

/**
 * `withHandle` supplies the sftp connection for the pane, opening or reviving
 * one as listing does, so the editor shares the connection the browser already
 * authenticated rather than asking the user for a password again.
 */
export function remoteBackend(
  api: RemoteEditApi,
  withHandle: <T>(run: (handle: string) => Promise<T>) => Promise<T>
): EditorBackend {
  return {
    async read(path) {
      const file = await withHandle((handle) => api.sftpReadFile(handle, path));
      return { path: file.path, text: file.text, version: file.text };
    },
    async write(path, text, version, overwrite) {
      if (typeof version !== 'string') throw new Error('That file was not opened from this host.');
      await withHandle((handle) => api.sftpWriteFile(handle, path, text, version, overwrite));
      // What the host now holds, which is what the next save must find there.
      return text;
    }
  };
}
