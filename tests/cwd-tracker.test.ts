import { describe, expect, it } from 'vitest';
import {
  parseOsc7Payload,
  parsePromptPath,
  parseWindowsOsc7Payload,
  parseWindowsPromptPath,
  readCwd,
  reportsWindowsPaths,
  resolveStartPath
} from '../src/renderer/cwd-tracker';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const osc7 = (payload: string) => `${ESC}]7;${payload}${BEL}`;

describe('OSC 7, the shell stating where it is', () => {
  it('decodes the file URL a shell reports', () => {
    expect(parseOsc7Payload('file://example.com/srv/app')).toBe('/srv/app');
    expect(parseOsc7Payload('file:///home/dev')).toBe('/home/dev');
    // Percent-encoding is not decoration: a directory really can contain a space.
    expect(parseOsc7Payload('file://host/home/dev/my%20project')).toBe('/home/dev/my project');
  });

  it('ignores a payload that is not one', () => {
    expect(parseOsc7Payload('0;window title')).toBeNull();
    expect(parseOsc7Payload('file://host/bad%2')).toBeNull();
  });

  it('takes the newest report in the buffer', () => {
    const buffer = `${osc7('file://host/first')}some output${osc7('file://host/second')}dev@host:~$ `;
    expect(readCwd(buffer)).toEqual({ path: '/second', source: 'osc7' });
  });
});

describe('the path inside a prompt', () => {
  it('reads the common shell prompts', () => {
    expect(parsePromptPath('dev@example:~/projects/api$ ')).toBe('~/projects/api');
    expect(parsePromptPath('root@example:/etc# ')).toBe('/etc');
    expect(parsePromptPath('dev@example:~$ ')).toBe('~');
    // Colour codes and a window title wrap almost every real prompt.
    expect(parsePromptPath(`${osc7('')}${ESC}[32mdev@example${ESC}[0m:${ESC}[34m/srv/app${ESC}[0m$ `)).toBe('/srv/app');
  });

  it('reports nothing rather than a path it would be guessing at', () => {
    // Only the base name is shown: at any depth below home this would be wrong.
    expect(parsePromptPath('[dev@example api]$ ')).toBeNull();
    // A Windows prompt cannot feed a POSIX remote path.
    expect(parsePromptPath('PS C:\\Users\\dev> ')).toBeNull();
    expect(parsePromptPath('Compiling 42 files...')).toBeNull();
    expect(parsePromptPath('')).toBeNull();
  });

  it('falls back to the prompt only when no report was made', () => {
    expect(readCwd('dev@example:/srv/app$ ')).toEqual({ path: '/srv/app', source: 'prompt' });
    expect(readCwd('make: nothing to be done\r\n')).toBeNull();
  });
});

describe('Windows shells on this machine', () => {
  it('reads the PowerShell and cmd prompts, spaces and all', () => {
    expect(parseWindowsPromptPath('PS C:\\Users\\dev\\ZeroGTerm> ')).toBe('C:\\Users\\dev\\ZeroGTerm');
    expect(parseWindowsPromptPath('PS C:\\Program Files\\Git> ')).toBe('C:\\Program Files\\Git');
    expect(parseWindowsPromptPath('C:\\Windows\\System32>')).toBe('C:\\Windows\\System32');
    expect(parseWindowsPromptPath('PS C:\\> ')).toBe('C:\\');
    expect(parseWindowsPromptPath(`${ESC}[32mPS D:\\work${ESC}[0m> `)).toBe('D:\\work');
  });

  it('is not fooled by a command typed after the prompt or by output', () => {
    expect(parseWindowsPromptPath('PS C:\\Users\\dev> cd ..')).toBeNull();
    expect(parseWindowsPromptPath('Copying C:\\a\\b to C:\\c')).toBeNull();
    expect(parseWindowsPromptPath('PS HKLM:\\Software> ')).toBeNull();
  });

  it('reads OSC 7 in URL form and in the run-together form the old snippet wrote', () => {
    expect(parseWindowsOsc7Payload('file://PC/C:/Users/dev/my%20project')).toBe('C:\\Users\\dev\\my project');
    expect(parseWindowsOsc7Payload('file://DESKTOP-1C:\\Users\\dev')).toBe('C:\\Users\\dev');
    expect(parseWindowsOsc7Payload('file://PC/C:/')).toBe('C:\\');
    expect(parseWindowsOsc7Payload('file://host/srv/app')).toBeNull();
  });

  it('applies only when asked, and only to local PowerShell and cmd', () => {
    expect(readCwd('PS C:\\Users\\dev> ')).toBeNull();
    expect(readCwd('PS C:\\Users\\dev> ', { windows: true })).toEqual({ path: 'C:\\Users\\dev', source: 'prompt' });
    // A Git Bash prompt still reads in a Windows-path session's buffer.
    expect(readCwd('dev@pc MINGW64 /c/work$ ', { windows: true })).toEqual({ path: '/c/work', source: 'prompt' });
    expect(reportsWindowsPaths({ kind: 'local', backend: 'powershell' })).toBe(true);
    expect(reportsWindowsPaths({ kind: 'local', backend: 'pwsh' })).toBe(true);
    expect(reportsWindowsPaths({ kind: 'local', backend: 'wsl' })).toBe(false);
    expect(reportsWindowsPaths({ kind: 'ssh', backend: 'powershell' })).toBe(false);
  });
});

describe('turning a reading into a directory to open at', () => {
  it('passes an absolute path through', () => {
    expect(resolveStartPath('/srv/app')).toEqual({ absolute: '/srv/app' });
  });

  it('keeps a home-relative path for the connection to resolve', () => {
    // `~` is a shell's expansion, and the SFTP client is not a shell — the rest
    // is joined onto the directory the connection actually lands in.
    expect(resolveStartPath('~/projects/api')).toEqual({ homeRelative: 'projects/api' });
  });

  it('asks for nothing when the terminal never said where it was', () => {
    expect(resolveStartPath('~')).toEqual({});
    expect(resolveStartPath(undefined)).toEqual({});
    expect(resolveStartPath('C:\\Users\\dev')).toEqual({});
  });
});
