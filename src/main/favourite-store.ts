import { join } from 'node:path';
import type { FavouriteDirectory, StoredFavouriteFile } from '../shared/types.js';
import { JsonFileStore, optionalText } from './json-file-store.js';

const SCHEMA_VERSION = 1;
export const MAX_FAVOURITES = 100;

/**
 * Main-process-only memory of the directories the user starred.
 *
 * Unlike the other stores this one does keep paths, because each was starred
 * on purpose — the same reason a workspace keeps the directory of a pane that
 * was explicitly created in one. Still never a command or a credential.
 */
export class FavouriteStore extends JsonFileStore<StoredFavouriteFile> {
  constructor(options: { filePath: string }) {
    super({
      filePath: options.filePath,
      normalize: normalizeFile,
      empty: () => ({ version: SCHEMA_VERSION, favourites: [] }),
      invalidMessage: 'Invalid favourite directory list.'
    });
  }
}

function normalizeEntry(value: unknown): FavouriteDirectory | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.place !== 'local' && item.place !== 'wsl' && item.place !== 'ssh') return undefined;
  const id = optionalText(item.id, 64);
  const path = optionalText(item.path, 1024);
  const added = optionalText(item.added, 40);
  if (!id || !path || !added || Number.isNaN(Date.parse(added))) return undefined;
  const entry: FavouriteDirectory = { id, place: item.place, path, added };
  const label = optionalText(item.label, 64);
  if (label) entry.label = label;
  if (item.place === 'local') {
    const backend = optionalText(item.backend, 32);
    if (backend) entry.backend = backend;
  }
  if (item.place === 'wsl') {
    const distro = optionalText(item.wslDistribution, 64);
    if (!distro) return undefined;
    entry.wslDistribution = distro;
  }
  if (item.place === 'ssh') {
    const host = optionalText(item.host, 256);
    if (!host) return undefined;
    entry.host = host;
    const target = optionalText(item.sshTarget, 256);
    if (target) entry.sshTarget = target;
  }
  return entry;
}

export function normalizeFile(value: unknown): StoredFavouriteFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== SCHEMA_VERSION) return undefined;
  if (!Array.isArray(item.favourites)) return undefined;
  const seen = new Set<string>();
  const favourites: FavouriteDirectory[] = [];
  for (const raw of item.favourites) {
    const entry = normalizeEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    favourites.push(entry);
  }
  return { version: SCHEMA_VERSION, favourites: favourites.slice(0, MAX_FAVOURITES) };
}

export function defaultFavouritePath(userDataPath: string): string {
  return join(userDataPath, 'favourite-directories.json');
}
