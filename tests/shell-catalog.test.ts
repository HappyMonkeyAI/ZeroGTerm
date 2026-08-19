import { describe, expect, it } from 'vitest';
import {
  defaultShellBackend,
  discoverShellBackends,
  findExecutable,
  findOpenSshTool,
  resolveShellBackend
} from '../src/main/shell-catalog';

/** Describe a machine by the absolute paths that exist on it. */
function machine(files: string[]) {
  const present = new Set(files.map((file) => file.toLowerCase()));
  return (candidate: string) => present.has(candidate.toLowerCase());
}

const WINDOWS_PATH = 'C:\\windows\\system32;C:\\Program Files\\PowerShell\\7;C:\\Program Files\\Git\\bin';
const UNIX_PATH = '/usr/local/bin:/usr/bin:/bin';

/** A stock Windows box: PowerShell 5.1, cmd and the WSL shim, nothing else. */
const stockWindows = {
  platform: 'win32' as const,
  path: WINDOWS_PATH,
  pathExt: '.EXE;.CMD;.BAT;.COM',
  isFile: machine([
    'C:\\windows\\system32\\powershell.exe',
    'C:\\windows\\system32\\cmd.exe',
    'C:\\windows\\system32\\wsl.exe',
    'C:\\windows\\system32\\bash.exe'
  ])
};

describe('findOpenSshTool', () => {
  it('prefers PATH, which is the only way to find an unusual install', () => {
    const scooped = {
      platform: 'win32' as const,
      path: 'C:\\Users\\dev\\scoop\\shims;C:\\windows\\system32',
      pathExt: '.EXE',
      isFile: machine(['C:\\Users\\dev\\scoop\\shims\\ssh.EXE'])
    };
    expect(findOpenSshTool('ssh', scooped)).toBe('C:\\Users\\dev\\scoop\\shims\\ssh.EXE');
  });

  it('falls back to the Windows install locations when PATH is stale', () => {
    // Enabling the OpenSSH client feature extends PATH for processes started
    // afterwards. A desktop app already running would otherwise decide that a
    // machine plainly holding ssh.exe does not have it.
    const staleEnvironment = {
      platform: 'win32' as const,
      path: 'C:\\windows\\system32',
      pathExt: '.EXE',
      env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      isFile: machine([
        'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
        'C:\\Windows\\System32\\OpenSSH\\sftp.exe'
      ])
    };
    expect(findOpenSshTool('ssh', staleEnvironment)).toBe('C:\\Windows\\System32\\OpenSSH\\ssh.exe');
    // Both tools ship together and are found the same way.
    expect(findOpenSshTool('sftp', staleEnvironment)).toBe('C:\\Windows\\System32\\OpenSSH\\sftp.exe');
  });

  it('finds the tools Git for Windows ships', () => {
    const gitOnly = {
      platform: 'win32' as const,
      path: 'C:\\windows\\system32',
      pathExt: '.EXE',
      env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      isFile: machine(['C:\\Program Files\\Git\\usr\\bin\\sftp.exe'])
    };
    expect(findOpenSshTool('sftp', gitOnly)).toBe('C:\\Program Files\\Git\\usr\\bin\\sftp.exe');
  });

  it('reports nothing rather than a guess when the tool is absent', () => {
    expect(findOpenSshTool('ssh', stockWindows)).toBeUndefined();
    // On Unix there are no fallback locations: PATH is the answer there.
    expect(findOpenSshTool('ssh', { platform: 'linux', path: UNIX_PATH, isFile: machine([]) })).toBeUndefined();
    expect(findOpenSshTool('ssh', { platform: 'linux', path: UNIX_PATH, isFile: machine(['/usr/bin/ssh']) })).toBe('/usr/bin/ssh');
  });
});

describe('findExecutable', () => {
  it('resolves a command to an absolute path on PATH', () => {
    expect(findExecutable('powershell.exe', stockWindows)).toBe('C:\\windows\\system32\\powershell.exe');
    expect(findExecutable('nothing.exe', stockWindows)).toBeUndefined();
  });

  it('applies PATHEXT on Windows, so a bare name still resolves', () => {
    // The extension comes from PATHEXT, which is upper case, and the filesystem
    // is case-insensitive there — so the casing of the suffix is not meaningful.
    expect(findExecutable('pwsh', {
      ...stockWindows,
      isFile: machine(['C:\\Program Files\\PowerShell\\7\\pwsh.exe'])
    })?.toLowerCase()).toBe('c:\\program files\\powershell\\7\\pwsh.exe');
  });

  it('does not invent extensions on Unix', () => {
    const unix = { platform: 'linux' as const, path: UNIX_PATH, isFile: machine(['/bin/bash']) };
    expect(findExecutable('bash', unix)).toBe('/bin/bash');
    expect(findExecutable('bash.exe', unix)).toBeUndefined();
  });
});

describe('discoverShellBackends on Windows', () => {
  it('offers Windows PowerShell on a machine without PowerShell 7', () => {
    // The regression this replaces: the shipped code only knew pwsh.exe, so a
    // stock Windows box was offered no PowerShell at all.
    const backends = discoverShellBackends(stockWindows);
    expect(backends.map((shell) => shell.backend)).toEqual(['powershell', 'cmd', 'wsl']);
    expect(backends[0].label).toBe('Windows PowerShell');
    expect(backends[0].executable).toBe('C:\\windows\\system32\\powershell.exe');
  });

  it('offers 5.1 and 7 as separate backends when both are installed', () => {
    const both = {
      ...stockWindows,
      isFile: machine([
        'C:\\windows\\system32\\powershell.exe',
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\windows\\system32\\cmd.exe'
      ])
    };
    const backends = discoverShellBackends(both);
    expect(backends.map((shell) => shell.backend)).toEqual(['powershell', 'pwsh', 'cmd']);
    expect(backends.map((shell) => shell.label)).toEqual(['Windows PowerShell', 'PowerShell 7', 'Command Prompt']);
  });

  it('skips System32 bash, which is the WSL shim rather than Git Bash', () => {
    // It exists on every Windows 10 and 11 machine, and a "Git Bash" entry that
    // starts WSL — or nothing, without a distribution — is worse than none.
    expect(discoverShellBackends(stockWindows).some((shell) => shell.backend === 'bash')).toBe(false);
  });

  it('offers Git Bash when Git for Windows installed it', () => {
    const withGit = {
      ...stockWindows,
      isFile: machine([
        'C:\\windows\\system32\\powershell.exe',
        'C:\\windows\\system32\\bash.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe'
      ])
    };
    const bash = discoverShellBackends(withGit).find((shell) => shell.backend === 'bash');
    expect(bash?.label).toBe('Git Bash');
    expect(bash?.executable).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('resolves to absolute paths, which node-pty needs on Windows', () => {
    // node-pty does not apply PATHEXT, so a bare `bash` fails there.
    for (const shell of discoverShellBackends(stockWindows)) {
      expect(shell.executable).toMatch(/^[A-Za-z]:\\/);
    }
  });
});

describe('discoverShellBackends on Unix', () => {
  const unix = {
    platform: 'linux' as const,
    path: UNIX_PATH,
    isFile: machine(['/bin/bash', '/usr/bin/zsh', '/usr/bin/fish', '/bin/sh'])
  };

  it('offers the shells that are installed, bash first', () => {
    expect(discoverShellBackends({ ...unix, loginShell: undefined }).map((shell) => shell.backend))
      .toEqual(['bash', 'zsh', 'fish', 'sh']);
  });

  it('puts the login shell first and says so', () => {
    const backends = discoverShellBackends({ ...unix, loginShell: '/usr/bin/zsh' });
    expect(backends.map((shell) => shell.backend)).toEqual(['zsh', 'bash', 'fish', 'sh']);
    expect(backends[0].label).toBe('Zsh (login shell)');
  });

  it('ignores a login shell it cannot name, rather than spawning something unknown', () => {
    const backends = discoverShellBackends({ ...unix, loginShell: '/usr/bin/nu' });
    expect(backends.map((shell) => shell.backend)).toEqual(['bash', 'zsh', 'fish', 'sh']);
  });

  it('leaves out shells this machine does not have', () => {
    const minimal = { platform: 'linux' as const, path: UNIX_PATH, isFile: machine(['/bin/sh']) };
    expect(discoverShellBackends(minimal).map((shell) => shell.backend)).toEqual(['sh']);
  });
});

describe('defaultShellBackend', () => {
  it('prefers a native shell on Windows', () => {
    expect(defaultShellBackend(stockWindows).backend).toBe('powershell');
  });

  it('prefers the login shell on Unix', () => {
    expect(defaultShellBackend({
      platform: 'linux',
      path: UNIX_PATH,
      loginShell: '/usr/bin/zsh',
      isFile: machine(['/bin/bash', '/usr/bin/zsh'])
    }).backend).toBe('zsh');
  });

  it('fails clearly when there is no shell at all', () => {
    expect(() => defaultShellBackend({ platform: 'linux', path: UNIX_PATH, isFile: () => false }))
      .toThrow('No usable shell');
  });
});

describe('resolveShellBackend', () => {
  it('returns what to spawn for an installed backend', () => {
    const shell = resolveShellBackend('cmd', undefined, stockWindows);
    expect(shell).toMatchObject({
      backend: 'cmd',
      executable: 'C:\\windows\\system32\\cmd.exe',
      args: [],
      label: 'Command Prompt'
    });
  });

  it('names the missing shell instead of failing at spawn time', () => {
    expect(() => resolveShellBackend('pwsh', undefined, stockWindows))
      .toThrow('PowerShell 7 is not installed or unavailable.');
    expect(() => resolveShellBackend('zsh', undefined, stockWindows))
      .toThrow('is not installed or unavailable.');
  });

  it('passes a WSL distribution as argv, and rejects an unsafe name', () => {
    const shell = resolveShellBackend('wsl', 'Ubuntu', stockWindows);
    expect(shell.args).toEqual(['-d', 'Ubuntu']);
    expect(shell.label).toBe('WSL · Ubuntu');
    expect(shell.wslDistribution).toBe('Ubuntu');
    // A name reaching `wsl.exe -d` must not be able to start with a flag or
    // carry shell metacharacters.
    expect(() => resolveShellBackend('wsl', 'Ubuntu; rm -rf /', stockWindows)).toThrow();
    expect(() => resolveShellBackend('wsl', '-d', stockWindows)).toThrow();
  });

  it('uses the plain WSL entry when no distribution is named', () => {
    expect(resolveShellBackend('wsl', undefined, stockWindows).args).toEqual([]);
  });
});
