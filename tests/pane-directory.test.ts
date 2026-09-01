import { describe, expect, it } from 'vitest';
import {
  changeDirectoryCommand,
  isWslSession,
  joinPath,
  listingPathFor,
  parentOf,
  pathKindFor,
  resolveHome,
  shellFamily,
  shellPathFor,
  wslPosixPath,
  wslUncPath,
  type PathKind
} from '../src/renderer/pane-directory';
import type { SessionInfo } from '../src/shared/types';

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'local:api',
    name: 'api',
    kind: 'local',
    host: 'local',
    cwd: '/home/dev',
    status: 'connected',
    lastSeen: '2026-09-01T00:00:00.000Z',
    backend: 'bash',
    scope: 'local',
    source: 'active',
    ...overrides
  };
}

const wsl = session({ backend: 'wsl', wslDistribution: 'Ubuntu-22.04', cwd: '/home/stephen' });
const ssh = session({ id: 'ssh:1', kind: 'ssh', host: 'build.example.com', backend: 'ssh', cwd: '/srv/app' });
const powershell = session({ backend: 'powershell', cwd: 'C:\\Users\\dev' });

/**
 * Directory names a listing can genuinely contain, each of which would do
 * something other than change directory if it reached a shell unquoted.
 */
const HOSTILE = [
  'plain',
  'with space',
  "it's here",
  'semi;colon',
  '$(touch pwned)',
  '`touch pwned`',
  'and && or',
  'pipe|it',
  'star*',
  'brackets[1]',
  'quote"inside',
  'dollar$HOME',
  '-leading-dash',
  'tab\there',
  'new\nline'
];

describe('shellFamily', () => {
  it('reads the family from the backend', () => {
    expect(shellFamily(ssh)).toBe('posix');
    expect(shellFamily(wsl)).toBe('posix');
    expect(shellFamily(session({ backend: 'zsh' }))).toBe('posix');
    expect(shellFamily(session({ backend: 'screen' }))).toBe('posix');
    expect(shellFamily(powershell)).toBe('powershell');
    expect(shellFamily(session({ backend: 'pwsh' }))).toBe('powershell');
    expect(shellFamily(session({ backend: 'cmd' }))).toBe('cmd');
  });

  it('refuses to guess when the backend is unknown', () => {
    // A session restored from history may name none, and the wrong quoting rule
    // is a command the user did not ask for.
    expect(shellFamily(session({ backend: undefined }))).toBeNull();
    expect(shellFamily(null)).toBeNull();
  });
});

describe('the WSL bridge', () => {
  it('builds the share path Windows serves the distro on', () => {
    expect(wslUncPath('Ubuntu-22.04', '/home/stephen')).toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`);
    expect(wslUncPath('Ubuntu-22.04', '/etc')).toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\etc`);
  });

  it('gives the share root something after it, which readdir needs', () => {
    expect(wslUncPath('Ubuntu-22.04', '/')).toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\.`);
    expect(wslUncPath('Ubuntu-22.04', '')).toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\.`);
  });

  it('treats the Windows drives inside the distro as ordinary distro paths', () => {
    // /mnt/c is served by the share too, so there is one rule rather than two.
    expect(wslUncPath('Ubuntu-22.04', '/mnt/c/Users/dev'))
      .toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\mnt\c\Users\dev`);
  });

  it('translates back', () => {
    expect(wslPosixPath('Ubuntu-22.04', String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`)).toBe('/home/stephen');
    expect(wslPosixPath('Ubuntu-22.04', String.raw`\\wsl.localhost\Ubuntu-22.04\.`)).toBe('/');
  });

  it('understands the older share spelling, which early builds use', () => {
    expect(wslPosixPath('Ubuntu-22.04', String.raw`\\wsl$\Ubuntu-22.04\home`)).toBe('/home');
  });

  it('is case-insensitive about the share, as Windows is', () => {
    expect(wslPosixPath('Ubuntu-22.04', String.raw`\\WSL.LOCALHOST\Ubuntu-22.04\home`)).toBe('/home');
  });

  it('refuses a path outside the distribution', () => {
    // Somewhere the shell inside the distro cannot be told to go, so inventing a
    // translation would produce a cd to a directory that does not exist there.
    expect(wslPosixPath('Ubuntu-22.04', String.raw`C:\Users\dev`)).toBeNull();
    expect(wslPosixPath('Ubuntu-22.04', String.raw`\\wsl.localhost\Debian\home`)).toBeNull();
    expect(wslPosixPath('Ubuntu-22.04', String.raw`\\server\share\home`)).toBeNull();
  });

  it('round-trips', () => {
    for (const path of ['/home/stephen', '/etc/ssh', '/mnt/c/Users/dev', '/']) {
      expect(wslPosixPath('Ubuntu-22.04', wslUncPath('Ubuntu-22.04', path))).toBe(path);
    }
  });
});

describe('listingPathFor', () => {
  it('lists an SSH pane at the path the remote shell reports', () => {
    expect(listingPathFor(ssh)).toBe('/srv/app');
  });

  it('lists a native local pane where it says it is', () => {
    expect(listingPathFor(powershell)).toBe('C:\\Users\\dev');
  });

  it('lists a WSL pane through the share', () => {
    expect(listingPathFor(wsl)).toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`);
  });

  it('reports nothing for a WSL pane that has only said "~"', () => {
    // A shell whose prompt says `~` has told us a symbol, not a directory.
    expect(listingPathFor(session({ ...wsl, cwd: '~' }))).toBeNull();
  });

  it('uses a known home to resolve "~"', () => {
    expect(listingPathFor(session({ ...wsl, cwd: '~' }), '/home/stephen'))
      .toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`);
    expect(listingPathFor(session({ ...wsl, cwd: '~/projects' }), '/home/stephen'))
      .toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen\projects`);
  });

  it('reports nothing when the shell has said nothing at all', () => {
    expect(listingPathFor(session({ cwd: '' }))).toBeNull();
    expect(listingPathFor(null)).toBeNull();
  });
});

describe('shellPathFor', () => {
  it('is the listing path everywhere but WSL', () => {
    expect(shellPathFor(ssh, '/srv/other')).toBe('/srv/other');
    expect(shellPathFor(powershell, 'C:\\srv')).toBe('C:\\srv');
  });

  it('turns a share path back into a distro path', () => {
    expect(shellPathFor(wsl, String.raw`\\wsl.localhost\Ubuntu-22.04\etc\ssh`)).toBe('/etc/ssh');
  });

  it('refuses a share path from another distribution', () => {
    expect(shellPathFor(wsl, String.raw`\\wsl.localhost\Debian\etc`)).toBeNull();
  });
});

describe('resolveHome', () => {
  it('substitutes a known home and nothing else', () => {
    expect(resolveHome('~', '/home/dev')).toBe('/home/dev');
    expect(resolveHome('~/x', '/home/dev')).toBe('/home/dev/x');
    expect(resolveHome('~', undefined)).toBeNull();
    expect(resolveHome('/srv', undefined)).toBe('/srv');
    expect(resolveHome(undefined, '/home/dev')).toBeNull();
  });

  it('does not mistake a name beginning with a tilde for the home directory', () => {
    expect(resolveHome('~backup', '/home/dev')).toBe('~backup');
  });
});

describe('parentOf', () => {
  it('walks up a POSIX path and stops at the root', () => {
    expect(parentOf('/srv/app/src', 'posix')).toBe('/srv/app');
    expect(parentOf('/srv', 'posix')).toBe('/');
    expect(parentOf('/', 'posix')).toBeNull();
  });

  it('walks up a Windows path and stops at the drive', () => {
    expect(parentOf('C:\\Users\\dev\\src', 'windows')).toBe('C:\\Users\\dev');
    expect(parentOf('C:\\Users', 'windows')).toBe('C:\\');
    expect(parentOf('C:\\', 'windows')).toBeNull();
  });

  it('walks up a share path and stops at the distribution root', () => {
    // Above the share is the list of distributions, which is not somewhere the
    // shell inside one can be told to go.
    expect(parentOf(String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`, 'unc'))
      .toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\home`);
    expect(parentOf(String.raw`\\wsl.localhost\Ubuntu-22.04\home`, 'unc'))
      .toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\.`);
    expect(parentOf(String.raw`\\wsl.localhost\Ubuntu-22.04\.`, 'unc')).toBeNull();
  });

  it('tolerates a trailing separator', () => {
    expect(parentOf('/srv/app/', 'posix')).toBe('/srv');
    expect(parentOf('C:\\Users\\dev\\', 'windows')).toBe('C:\\Users');
  });
});

describe('pathKindFor', () => {
  it('names the kind of path each pane walks', () => {
    expect(pathKindFor(ssh)).toBe('posix');
    expect(pathKindFor(wsl)).toBe('unc');
    expect(pathKindFor(powershell)).toBe('windows');
    expect(pathKindFor(session({ backend: 'bash', cwd: '/home/dev' }))).toBe('posix');
    expect(pathKindFor(session({ backend: undefined }))).toBeNull();
  });
});

describe('isWslSession', () => {
  it('needs a distribution as well as the backend', () => {
    expect(isWslSession(wsl)).toBe(true);
    expect(isWslSession(session({ backend: 'wsl', wslDistribution: undefined }))).toBe(false);
    expect(isWslSession(ssh)).toBe(false);
  });
});

describe('changeDirectoryCommand', () => {
  it('quotes a plain path', () => {
    expect(changeDirectoryCommand('posix', '/srv/app')).toEqual({ command: "cd '/srv/app'" });
    expect(changeDirectoryCommand('powershell', 'C:\\srv'))
      .toEqual({ command: "Set-Location -LiteralPath 'C:\\srv'" });
    expect(changeDirectoryCommand('cmd', 'C:\\srv')).toEqual({ command: 'cd /d "C:\\srv"' });
  });

  it('closes and reopens a POSIX quote around the quote character', () => {
    // The only character single quotes cannot contain. Built rather than
    // written out, because an exact-string expectation for this is itself a
    // backslash-escaping puzzle and gets the test wrong more often than the code.
    const escaped = ["cd '/srv/it", "'", String.raw`\'`, "'", "s here'"].join('');
    expect(changeDirectoryCommand('posix', "/srv/it's here")).toEqual({ command: escaped });
  });

  it('doubles a quote for PowerShell', () => {
    expect(changeDirectoryCommand('powershell', "C:\\it's here"))
      .toEqual({ command: "Set-Location -LiteralPath 'C:\\it''s here'" });
  });

  it('uses -LiteralPath, without which quoting would not help', () => {
    // Set-Location treats its argument as a wildcard, so a directory genuinely
    // named [test] would not be found however well it was quoted.
    const result = changeDirectoryCommand('powershell', 'C:\\brackets[1]');
    expect('command' in result && result.command).toContain('-LiteralPath');
  });

  it('changes drive for cmd, which cd alone will not', () => {
    expect(changeDirectoryCommand('cmd', 'D:\\work')).toEqual({ command: 'cd /d "D:\\work"' });
  });

  it('refuses a name cmd cannot quote', () => {
    // cmd has no escape for a double quote inside a quoted string.
    expect(changeDirectoryCommand('cmd', 'C:\\quote"inside')).toEqual({
      refused: 'Command Prompt cannot quote a directory name containing a double quote.'
    });
  });

  it('refuses a line break for every family', () => {
    // A newline ends the command line, so what follows is a second command and
    // no quoting reaches it.
    for (const family of ['posix', 'powershell', 'cmd'] as const) {
      expect(changeDirectoryCommand(family, '/srv/new\nline')).toMatchObject({ refused: expect.any(String) });
      expect(changeDirectoryCommand(family, '/srv/carriage\rreturn')).toMatchObject({ refused: expect.any(String) });
    }
  });

  it('refuses an empty path', () => {
    expect(changeDirectoryCommand('posix', '')).toMatchObject({ refused: expect.any(String) });
  });

  it('never lets a hostile name out of its quotes', () => {
    // The property that matters, over the whole table: whatever the name, the
    // command is one `cd` and everything after the opening quote stays inside it.
    for (const name of HOSTILE) {
      const path = `/tmp/${name}`;
      const posix = changeDirectoryCommand('posix', path);
      if ('refused' in posix) {
        // Only the line-break cases may be refused.
        expect(name).toMatch(/[\r\n]/);
        continue;
      }
      expect(posix.command.startsWith("cd '")).toBe(true);
      expect(posix.command.endsWith("'")).toBe(true);
      // Every quote inside is part of the close-escape-reopen dance, so the
      // number of quote characters is always odd-free: pairs plus the outer two.
      const unescaped = posix.command.slice(4, -1).split(String.raw`'\''`).join('');
      expect(unescaped).not.toContain("'");
    }
  });
});

describe('joinPath', () => {
  it('joins a POSIX path without doubling the separator at the root', () => {
    expect(joinPath('/srv/app', 'src', 'posix')).toBe('/srv/app/src');
    expect(joinPath('/', 'srv', 'posix')).toBe('/srv');
    expect(joinPath('/srv/', 'app', 'posix')).toBe('/srv/app');
  });

  it('joins a Windows path with backslashes', () => {
    expect(joinPath(String.raw`C:\Users\dev`, 'src', 'windows')).toBe(String.raw`C:\Users\dev\src`);
    expect(joinPath('C:\\', 'Users', 'windows')).toBe(String.raw`C:\Users`);
  });

  it('replaces the share root marker rather than extending it', () => {
    // wslUncPath renders `/` as `…\.` because readdir needs something after the
    // share, so a child of that must not become `…\.\home`.
    expect(joinPath(String.raw`\\wsl.localhost\Ubuntu-22.04\.`, 'home', 'unc'))
      .toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\home`);
    expect(joinPath(String.raw`\\wsl.localhost\Ubuntu-22.04\home`, 'stephen', 'unc'))
      .toBe(String.raw`\\wsl.localhost\Ubuntu-22.04\home\stephen`);
  });

  it('keeps a name with a space or a quote intact, which quoting deals with later', () => {
    expect(joinPath('/tmp', "it's here", 'posix')).toBe("/tmp/it's here");
  });

  it('round-trips against parentOf', () => {
    const cases: Array<[string, PathKind]> = [
      ['/srv/app', 'posix'],
      [String.raw`C:\Users\dev`, 'windows'],
      [String.raw`\\wsl.localhost\D\home`, 'unc']
    ];
    for (const [parent, kind] of cases) {
      expect(parentOf(joinPath(parent, 'child', kind), kind)).toBe(parent);
    }
  });
});
