import { describe, expect, it } from 'vitest';
import { parseOsc7Payload, parsePromptPath, readCwd, resolveStartPath } from '../src/renderer/cwd-tracker';

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
