// Path and listing arithmetic shared by the transfer panel and the services
// behind it. Pure, so it can be unit tested and so the renderer can reason about
// paths without a filesystem — the renderer has no Node path module, and the
// remote side is POSIX regardless of what the local machine is.

import type { FileEntry } from './types.js';

/** Directories first, then names, case-insensitively — the order a person scans. */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const rank = (entry: FileEntry) => (entry.kind === 'directory' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

/** Join a remote directory and a child name. Remote paths are always POSIX. */
export function joinRemote(dir: string, name: string): string {
  if (name.startsWith('/')) return name;
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`;
}

/** The remote directory above this one; the root is its own parent. */
export function parentRemote(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return '/';
  return trimmed.slice(0, cut);
}

/**
 * Is this local path a Windows one?
 *
 * Decided from the path itself rather than from the platform: the renderer is
 * given paths by the main process and has no way to ask which OS it is on.
 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:/.test(path) || path.startsWith('\\\\') || path.includes('\\');
}

export function joinLocal(dir: string, name: string): string {
  const separator = isWindowsPath(dir) ? '\\' : '/';
  // The trim also strips a root's own separator, which the rejoin puts back:
  // `C:\` becomes `C:` and then `C:\name`, and `/` becomes '' and then `/name`.
  const base = dir.replace(/[\\/]+$/, '');
  return `${base}${separator}${name}`;
}

/** The local directory above this one; a root is its own parent. */
export function parentLocal(path: string): string {
  const windows = isWindowsPath(path);
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return path;
  if (!windows) return cut === 0 ? '/' : trimmed.slice(0, cut);
  const head = trimmed.slice(0, cut);
  // `C:\Users` -> `C:\`, not `C:`, which no API accepts as a directory.
  return /^[A-Za-z]:$/.test(head) ? `${head}\\` : head || '\\';
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** A size a person can read at a glance. Directories are not measured. */
export function formatSize(entry: FileEntry): string {
  if (entry.kind === 'directory') return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = entry.size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * The modified column.
 *
 * Local listings carry an ISO timestamp; remote ones carry whatever the server's
 * `ls` printed, which is already meant for reading and is passed through.
 */
export function formatModified(value?: string): string {
  if (!value) return '';
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!iso) return value;
  const [, year, month, day, hour, minute] = iso;
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
