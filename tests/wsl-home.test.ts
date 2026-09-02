import { describe, expect, it, vi } from 'vitest';
import { parseWslHome, wslHomeDirectory } from '../src/main/wsl-home';

describe('parseWslHome', () => {
  it('takes an absolute POSIX path', () => {
    expect(parseWslHome('/home/stephen')).toBe('/home/stephen');
    expect(parseWslHome('/root\n')).toBe('/root');
    expect(parseWslHome('  /home/dev  ')).toBe('/home/dev');
  });

  it('refuses anything that is not one absolute path', () => {
    // This value becomes part of a path that gets listed, so a distro that
    // answered something surprising is a distro to give up on rather than to
    // second-guess.
    expect(parseWslHome('')).toBeNull();
    expect(parseWslHome('home/stephen')).toBeNull();
    expect(parseWslHome('C:\Users\dev')).toBeNull();
    expect(parseWslHome('/home/a\n/home/b')).toBeNull();
    expect(parseWslHome('/home/\u0000dev')).toBeNull();
    expect(parseWslHome(`/${'x'.repeat(5000)}`)).toBeNull();
  });
});

describe('wslHomeDirectory', () => {
  function fakeRun(result: { error?: Error; stdout?: string }) {
    const calls: Array<{ file: string; args: string[] }> = [];
    const run = ((file: string, args: string[], _options: unknown, callback: Function) => {
      calls.push({ file, args });
      callback(result.error ?? null, result.stdout ?? '', '');
      return { on: () => undefined };
    }) as never;
    return { run, calls };
  }

  it('asks the distribution and returns what it said', async () => {
    const { run, calls } = fakeRun({ stdout: '/home/stephen' });
    expect(await wslHomeDirectory('Ubuntu-22.04', run)).toBe('/home/stephen');
    // argv, not a command line: the distribution name is an argument, so it
    // cannot become part of the command being run.
    expect(calls[0]).toEqual({
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu-22.04', '--', 'sh', '-c', 'printf %s "$HOME"']
    });
  });

  it('strips the NULs a UTF-16 answer leaves behind', async () => {
    const { run } = fakeRun({ stdout: '/\u0000h\u0000o\u0000m\u0000e\u0000' });
    expect(await wslHomeDirectory('Ubuntu', run)).toBe('/home');
  });

  it('reports nothing when the distribution will not answer', async () => {
    const { run } = fakeRun({ error: new Error('There is no distribution with that name.') });
    expect(await wslHomeDirectory('Ubuntu', run)).toBeNull();
  });

  it('refuses a distribution name it will not pass on, without running anything', async () => {
    const { run, calls } = fakeRun({ stdout: '/home/dev' });
    for (const name of ['', 'a b', 'Ubuntu; rm -rf /', '-d', 'x'.repeat(65)]) {
      expect(await wslHomeDirectory(name, run), name).toBeNull();
    }
    expect(calls).toEqual([]);
  });
});
