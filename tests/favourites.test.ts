import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FavouriteStore, MAX_FAVOURITES, normalizeFile } from '../src/main/favourite-store';
import {
  EMPTY_FAVOURITES,
  findFavourite,
  groupFavourites,
  isReachableFrom,
  placeOf,
  planJump,
  removeFavourite,
  toggleFavourite
} from '../src/renderer/favourites';
import type { SessionInfo, StoredFavouriteFile } from '../src/shared/types';

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return { id: 'id', name: 'term', kind: 'local', host: 'local', cwd: 'C:\\Users\\me', status: 'connected', lastSeen: '', ...overrides };
}

const powershell = session({ id: 'ps', backend: 'powershell' });
const gitBash = session({ id: 'gb', backend: 'bash', cwd: '/c/Users/me' });
const ubuntu = session({ id: 'wsl', backend: 'wsl', wslDistribution: 'Ubuntu', cwd: '/home/me' });
const web = session({ id: 'web', kind: 'ssh', host: 'web.example.com', sshTarget: 'me@web.example.com:22', cwd: '/var/www' });
const opts = (id: string) => ({ now: new Date('2026-11-09T12:00:00.000Z'), id });

function starred(...entries: Array<[SessionInfo, string]>): StoredFavouriteFile {
  return entries.reduce((file, [where, path], index) => toggleFavourite(file, where, path, opts(`f${index}`)), EMPTY_FAVOURITES);
}

describe('placeOf', () => {
  it('names the machine a pane is on', () => {
    expect(placeOf(powershell)).toEqual({ place: 'local', backend: 'powershell' });
    expect(placeOf(ubuntu)).toEqual({ place: 'wsl', wslDistribution: 'Ubuntu' });
    expect(placeOf(web)).toEqual({ place: 'ssh', host: 'web.example.com', sshTarget: 'me@web.example.com:22' });
  });
});

describe('toggling', () => {
  it('stars, finds and unstars a directory', () => {
    const file = starred([powershell, 'C:\\work\\api']);
    expect(file.favourites).toHaveLength(1);
    expect(file.favourites[0]).toMatchObject({ place: 'local', backend: 'powershell', path: 'C:\\work\\api' });
    // Windows paths match without case, slash style or a trailing separator.
    expect(findFavourite(file, powershell, 'c:/WORK/api/')).toBeDefined();
    expect(toggleFavourite(file, powershell, 'C:\\work\\api', opts('x')).favourites).toHaveLength(0);
  });

  it('keeps the same path on different machines apart', () => {
    const file = starred([ubuntu, '/srv/app']);
    expect(findFavourite(file, web, '/srv/app')).toBeUndefined();
    expect(toggleFavourite(file, web, '/srv/app', opts('y')).favourites).toHaveLength(2);
  });

  it('refuses a path that is not absolute', () => {
    expect(toggleFavourite(EMPTY_FAVOURITES, web, '~/api', opts('z'))).toBe(EMPTY_FAVOURITES);
  });

  it('removes by id', () => {
    const file = starred([powershell, 'C:\\a'], [ubuntu, '/b']);
    expect(removeFavourite(file, 'f0').favourites.map((favourite) => favourite.path)).toEqual(['/b']);
  });
});

describe('reachability and jumping', () => {
  const file = starred([powershell, 'C:\\work'], [gitBash, '/c/tools'], [ubuntu, '/home/me/api'], [web, '/var/www/site']);
  const [psFav, bashFav, wslFav, sshFav] = file.favourites;

  it('only lets a pane cd to paths its shell can read', () => {
    expect(isReachableFrom(psFav, powershell)).toBe(true);
    expect(isReachableFrom(bashFav, powershell)).toBe(false);
    expect(isReachableFrom(psFav, gitBash)).toBe(false);
    expect(isReachableFrom(sshFav, session({ kind: 'ssh', host: 'WEB.example.com', sshTarget: 'other@web.example.com' }))).toBe(true);
    expect(groupFavourites(file, ubuntu).here.map((favourite) => favourite.path)).toEqual(['/home/me/api']);
  });

  it('cds the focused pane, translating a WSL path to the share it is listed through', () => {
    expect(planJump(psFav, powershell)).toEqual({ kind: 'cd', listingPath: 'C:\\work' });
    expect(planJump(wslFav, ubuntu)).toEqual({ kind: 'cd', listingPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\api' });
  });

  it('opens a new local or WSL pane for a favourite elsewhere', () => {
    expect(planJump(wslFav, web)).toEqual({
      kind: 'open-local',
      request: { name: 'api', backend: 'wsl', wslDistribution: 'Ubuntu', cwd: '/home/me/api' }
    });
    expect(planJump(bashFav, powershell)).toEqual({ kind: 'open-local', request: { name: 'tools', backend: 'bash', cwd: '/c/tools' } });
    expect(planJump(psFav, null)).toEqual({ kind: 'open-local', request: { name: 'work', backend: 'powershell', cwd: 'C:\\work' } });
  });

  it('does not yet open an SSH favourite from another machine', () => {
    expect(planJump(sshFav, powershell).kind).toBe('unavailable');
  });
});

describe('favourite store', () => {
  async function file() {
    return join(await mkdtemp(join(tmpdir(), 'zerog-favourites-')), 'favourite-directories.json');
  }

  it('round trips, and tolerates a missing or broken file', async () => {
    const path = await file();
    expect(await new FavouriteStore({ filePath: path }).load()).toEqual({ version: 1, favourites: [] });
    const saved = starred([powershell, 'C:\\work'], [web, '/var/www']);
    await new FavouriteStore({ filePath: path }).save(saved);
    expect(await new FavouriteStore({ filePath: path }).load()).toEqual(saved);
    await writeFile(path, 'not json');
    expect(await new FavouriteStore({ filePath: path }).load()).toEqual({ version: 1, favourites: [] });
  });

  it('drops entries missing what their place needs, and caps the list', () => {
    const base = { id: 'a', path: '/x', added: '2026-11-09T12:00:00.000Z' };
    const normalized = normalizeFile({
      version: 1,
      favourites: [
        { ...base, place: 'wsl' },
        { ...base, id: 'b', place: 'ssh' },
        { ...base, id: 'c', place: 'elsewhere' },
        { ...base, id: 'd', place: 'local', path: `/a${String.fromCharCode(0)}b` },
        ...Array.from({ length: MAX_FAVOURITES + 5 }, (_, index) => ({ ...base, id: `n${index}`, place: 'local' }))
      ]
    });
    expect(normalized?.favourites[0]).toMatchObject({ id: 'd', path: '/ab' });
    expect(normalized?.favourites.some((entry) => ['a', 'b', 'c'].includes(entry.id))).toBe(false);
    expect(normalized?.favourites).toHaveLength(MAX_FAVOURITES);
  });
});
