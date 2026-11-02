import { describe, expect, it } from 'vitest';
import { looksLikeAbsolutePath, parseOpenCwd, sessionNameForCwd } from '../src/shared/open-cwd';

describe('open-cwd', () => {
  it('recognises absolute paths', () => {
    expect(looksLikeAbsolutePath('C:\\Users\\steph\\proj')).toBe(true);
    expect(looksLikeAbsolutePath('/home/steph/proj')).toBe(true);
    expect(looksLikeAbsolutePath('~/Documents')).toBe(true);
    expect(looksLikeAbsolutePath('--cwd')).toBe(false);
    expect(looksLikeAbsolutePath('relative')).toBe(false);
  });

  it('prefers --cwd over env and positionals', () => {
    expect(
      parseOpenCwd(['electron', '.', 'C:\\other', '--cwd', 'C:\\wanted'], {
        ZEROG_OPEN_CWD: 'C:\\env'
      })
    ).toBe('C:\\wanted');
    expect(parseOpenCwd(['ZeroG Terminal.exe', '--cwd=D:\\apps\\x'])).toBe('D:\\apps\\x');
  });

  it('falls back to ZEROG_OPEN_CWD then bare absolute argv', () => {
    expect(parseOpenCwd(['electron', '.'], { ZEROG_OPEN_CWD: 'C:\\from-env' })).toBe('C:\\from-env');
    expect(parseOpenCwd(['C:\\Program Files\\ZeroG Terminal\\ZeroG Terminal.exe', 'C:\\Users\\steph\\code'])).toBe(
      'C:\\Users\\steph\\code'
    );
    expect(parseOpenCwd(['electron', '.', 'C:\\Users\\steph\\code'])).toBe('C:\\Users\\steph\\code');
  });

  it('ignores launcher noise when no hint is present', () => {
    expect(parseOpenCwd(['C:\\Apps\\ZeroG Terminal.exe'])).toBeNull();
    expect(parseOpenCwd(['electron', '.'])).toBeNull();
  });

  it('builds a screen-safe session name from the directory', () => {
    expect(sessionNameForCwd('C:\\Users\\steph\\Documents\\development\\zerogfileman')).toBe('zerogfileman');
    expect(sessionNameForCwd('/tmp/My Project!')).toBe('My-Project');
  });
});
