import { describe, expect, it } from 'vitest';
import { baseName, formatModified, formatSize, isWindowsPath, joinLocal, joinRemote, parentLocal, parentRemote, sortEntries } from '../src/shared/files';
import type { FileEntry } from '../src/shared/types';

const file = (name: string, kind: FileEntry['kind'] = 'file', size = 0): FileEntry => ({ name, kind, size });

describe('remote paths', () => {
  it('joins and climbs POSIX paths', () => {
    expect(joinRemote('/srv/app', 'notes.md')).toBe('/srv/app/notes.md');
    expect(joinRemote('/srv/app/', 'notes.md')).toBe('/srv/app/notes.md');
    expect(joinRemote('/', 'srv')).toBe('/srv');
    // An absolute name is already a path; it must not be appended to another.
    expect(joinRemote('/srv/app', '/etc/hosts')).toBe('/etc/hosts');
    expect(parentRemote('/srv/app/releases')).toBe('/srv/app');
    expect(parentRemote('/srv')).toBe('/');
    // The root is its own parent, so climbing from it is a no-op, not an error.
    expect(parentRemote('/')).toBe('/');
  });
});

describe('local paths, decided from the path itself', () => {
  it('recognises Windows paths without asking the platform', () => {
    expect(isWindowsPath('C:\\Users\\dev')).toBe(true);
    expect(isWindowsPath('/home/dev')).toBe(false);
  });

  it('joins with the separator the path is already using', () => {
    expect(joinLocal('C:\\Users\\dev', 'app.zip')).toBe('C:\\Users\\dev\\app.zip');
    expect(joinLocal('C:\\', 'Users')).toBe('C:\\Users');
    expect(joinLocal('/home/dev', 'app.zip')).toBe('/home/dev/app.zip');
    expect(joinLocal('/', 'home')).toBe('/home');
  });

  it('climbs to a root that filesystem calls will still accept', () => {
    expect(parentLocal('C:\\Users\\dev')).toBe('C:\\Users');
    // `C:` alone is not a directory to any API; the separator has to stay.
    expect(parentLocal('C:\\Users')).toBe('C:\\');
    expect(parentLocal('/home/dev')).toBe('/home');
    expect(parentLocal('/home')).toBe('/');
  });

  it('takes the last segment of either flavour of path', () => {
    expect(baseName('C:\\Users\\dev\\app.zip')).toBe('app.zip');
    expect(baseName('/srv/app/notes.md')).toBe('notes.md');
  });
});

describe('what the panel displays', () => {
  it('sorts directories first, then names case-insensitively', () => {
    const sorted = sortEntries([file('beta.txt'), file('Alpha', 'directory'), file('alpha.txt'), file('zeta', 'directory')]);
    expect(sorted.map((entry) => entry.name)).toEqual(['Alpha', 'zeta', 'alpha.txt', 'beta.txt']);
  });

  it('sizes files, and does not pretend to size folders', () => {
    expect(formatSize(file('a', 'file', 512))).toBe('512 B');
    expect(formatSize(file('a', 'file', 2048))).toBe('2.0 KB');
    expect(formatSize(file('a', 'file', 20 * 1024 * 1024))).toBe('20 MB');
    expect(formatSize(file('a', 'directory', 4096))).toBe('—');
  });

  it('shortens an ISO time and passes a server-written one through', () => {
    expect(formatModified('2026-08-19T09:41:02.000Z')).toBe('2026-08-19 09:41');
    // Remote listings carry whatever the server's ls printed; it is already
    // written for reading, and reformatting it would mean guessing a year.
    expect(formatModified('Aug 18 12:34')).toBe('Aug 18 12:34');
    expect(formatModified(undefined)).toBe('');
  });
});
