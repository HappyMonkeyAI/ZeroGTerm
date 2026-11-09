// Starred directories: which machine each belongs to, and what clicking one does.
//
// A path is only meaningful on its own machine — `/var/www` on a dev server is
// nothing in a local PowerShell pane — so every favourite carries its place, and
// the menu splits them into the ones the focused pane can `cd` to and the ones
// that need a pane of their own.
//
// Kept out of main.tsx so it can be unit tested: main.tsx calls createRoot at
// module scope and cannot be imported from a test.

import type { CreateLocalRequest, FavouriteDirectory, LocalShellBackend, SessionInfo, StoredFavouriteFile } from '../shared/types';
import { sessionNameForCwd } from '../shared/open-cwd';
import { isWslSession, shellFamily, wslUncPath } from './pane-directory';
import { normalizeHost } from './remote-screens';
import { BACKEND_LABELS } from './settings';

export const EMPTY_FAVOURITES: StoredFavouriteFile = { version: 1, favourites: [] };

type Place = Pick<FavouriteDirectory, 'place' | 'backend' | 'wslDistribution' | 'host' | 'sshTarget'>;

const LOCAL_BACKENDS = Object.keys(BACKEND_LABELS) as LocalShellBackend[];

/** Which machine a pane's shell is on, as a favourite records it. */
export function placeOf(session: SessionInfo | null | undefined): Place | null {
  if (!session) return null;
  if (session.kind === 'ssh') {
    const target = session.sshTarget || session.host;
    const host = target ? normalizeHost(target).toLowerCase() : '';
    return host ? { place: 'ssh', host, sshTarget: target } : null;
  }
  if (isWslSession(session)) return { place: 'wsl', wslDistribution: session.wslDistribution };
  const backend = LOCAL_BACKENDS.find((candidate) => candidate === session.backend);
  return backend ? { place: 'local', backend } : { place: 'local' };
}

export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(path);
}

/** Windows paths compare without case and either slash; others exactly. */
function samePath(a: string, b: string): boolean {
  const trim = (path: string) => (path.length > 1 ? path.replace(/[\\/]+$/, '') : path);
  if (isWindowsPath(a) && isWindowsPath(b)) {
    const norm = (path: string) => trim(path).replace(/\//g, '\\').toLowerCase();
    return norm(a) === norm(b);
  }
  return trim(a) === trim(b);
}

function samePlace(favourite: FavouriteDirectory, place: Place): boolean {
  if (favourite.place !== place.place) return false;
  if (place.place === 'wsl') return favourite.wslDistribution === place.wslDistribution;
  if (place.place === 'ssh') return favourite.host === place.host;
  return true;
}

/**
 * Can the focused pane `cd` straight to this favourite?
 *
 * For a local favourite the machine is not enough: a PowerShell pane cannot
 * use a Git Bash path like `/c/work`, and the other way round, so the path has
 * to be in the style this pane's shell reads.
 */
export function isReachableFrom(favourite: FavouriteDirectory, session: SessionInfo | null | undefined): boolean {
  const place = placeOf(session);
  if (!session || !place || !samePlace(favourite, place)) return false;
  if (favourite.place !== 'local') return true;
  const family = shellFamily(session);
  if (!family) return false;
  return isWindowsPath(favourite.path) === (family !== 'posix');
}

/** The favourite for this directory on this pane's machine, if it is starred. */
export function findFavourite(
  file: StoredFavouriteFile,
  session: SessionInfo | null | undefined,
  path: string | null | undefined
): FavouriteDirectory | undefined {
  const place = placeOf(session);
  if (!place || !path) return undefined;
  return file.favourites.find((favourite) => samePlace(favourite, place) && samePath(favourite.path, path));
}

/**
 * Star or unstar a directory.
 *
 * Only an absolute path can be starred: `~` is a shell's expansion, and a
 * quoted `cd '~/x'` does not expand it, so a favourite written that way would
 * not work when clicked.
 */
export function toggleFavourite(
  file: StoredFavouriteFile,
  session: SessionInfo | null | undefined,
  path: string,
  options: { now: Date; id: string }
): StoredFavouriteFile {
  const existing = findFavourite(file, session, path);
  if (existing) return removeFavourite(file, existing.id);
  const place = placeOf(session);
  if (!place || !isStarrable(path)) return file;
  const favourite: FavouriteDirectory = { id: options.id, path, added: options.now.toISOString(), ...withoutEmpty(place) };
  return { ...file, favourites: [...file.favourites, favourite] };
}

export function isStarrable(path: string | null | undefined): path is string {
  return Boolean(path && (path.startsWith('/') || isWindowsPath(path)));
}

export function removeFavourite(file: StoredFavouriteFile, id: string): StoredFavouriteFile {
  return { ...file, favourites: file.favourites.filter((favourite) => favourite.id !== id) };
}

function withoutEmpty(place: Place): Place {
  return Object.fromEntries(Object.entries(place).filter(([, value]) => value !== undefined)) as Place;
}

/** The menu's two groups: reachable from the focused pane, and everything else. */
export function groupFavourites(
  file: StoredFavouriteFile,
  session: SessionInfo | null | undefined
): { here: FavouriteDirectory[]; elsewhere: FavouriteDirectory[] } {
  const here: FavouriteDirectory[] = [];
  const elsewhere: FavouriteDirectory[] = [];
  for (const favourite of file.favourites) (isReachableFrom(favourite, session) ? here : elsewhere).push(favourite);
  return { here, elsewhere };
}

export type JumpPlan =
  /** `cd` the focused pane, through openDirectory, which takes a listing path. */
  | { kind: 'cd'; listingPath: string }
  /** Open a new local or WSL pane already in the directory. */
  | { kind: 'open-local'; request: CreateLocalRequest }
  | { kind: 'unavailable'; reason: string };

/** What clicking a favourite does, from the pane that has focus. */
export function planJump(favourite: FavouriteDirectory, session: SessionInfo | null | undefined): JumpPlan {
  if (isReachableFrom(favourite, session)) {
    const listingPath =
      favourite.place === 'wsl' && favourite.wslDistribution
        ? wslUncPath(favourite.wslDistribution, favourite.path)
        : favourite.path;
    return { kind: 'cd', listingPath };
  }
  const name = sessionNameForCwd(favourite.path);
  if (favourite.place === 'wsl') {
    return { kind: 'open-local', request: { name, backend: 'wsl', wslDistribution: favourite.wslDistribution, cwd: favourite.path } };
  }
  if (favourite.place === 'local') {
    const backend = LOCAL_BACKENDS.find((candidate) => candidate === favourite.backend);
    return { kind: 'open-local', request: backend ? { name, backend, cwd: favourite.path } : { name, cwd: favourite.path } };
  }
  return { kind: 'unavailable', reason: `Open a pane on ${favourite.host} first, then pick ${favourite.path} from there.` };
}

/** Where a favourite lives, in the words the menu uses. */
export function placeLabel(favourite: FavouriteDirectory): string {
  if (favourite.place === 'wsl') return `WSL · ${favourite.wslDistribution}`;
  if (favourite.place === 'ssh') return favourite.host ?? 'SSH';
  return 'This computer';
}
