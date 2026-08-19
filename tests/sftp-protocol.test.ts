import { describe, expect, it } from 'vitest';
import {
  buildSftpArgs,
  detectFatal,
  detectPrompt,
  endsWithPrompt,
  findError,
  isSafeRemotePath,
  parseListing,
  parseLsLine,
  parseProgress,
  parsePwd,
  quoteLocalPath,
  quoteRemotePath,
  responseBody,
  sftpExecutable
} from '../src/main/sftp-protocol';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('sftp command safety', () => {
  it('quotes ordinary paths, spaces included', () => {
    expect(quoteRemotePath('/srv/app/notes.md')).toBe('"/srv/app/notes.md"');
    expect(quoteRemotePath('/srv/my project/notes.md')).toBe('"/srv/my project/notes.md"');
  });

  it('refuses paths the sftp interpreter would re-read', () => {
    // Quotes and backslashes are consumed by the client's own argument splitter,
    // and glob characters by the expansion pass after it. Either way the file
    // acted on would not be the file named.
    for (const path of ['/srv/"quoted"', '/srv/back\\slash', '/srv/star*', '/srv/what?', '/srv/[set]', "/srv/it's", '/srv/a\nb', '']) {
      expect(isSafeRemotePath(path)).toBe(false);
      expect(() => quoteRemotePath(path)).toThrow();
    }
  });

  it('refuses control characters, tab and escape included', () => {
    // Tab is what the client's own argument splitter breaks words on, and an
    // escape character in a filename would be repeated into terminal output.
    // A quoted tab survives the splitter today, but this module's whole stance
    // is not to bet a delete on the client's undocumented parsing rules.
    for (const path of ['/srv/two\twords', '/srv/esc\u001bape', '/srv/bell\u0007', '/srv/del\u007f', '/srv/nul\0']) {
      expect(isSafeRemotePath(path)).toBe(false);
      expect(() => quoteRemotePath(path)).toThrow(/control characters/);
    }
    // Ordinary text, including non-ASCII, is not a control character.
    expect(isSafeRemotePath('/srv/naïve/über/日本語.txt')).toBe(true);
  });

  it('turns Windows separators into ones the client will not eat', () => {
    expect(quoteLocalPath('C:\\Users\\dev\\app.zip')).toBe('"C:/Users/dev/app.zip"');
  });

  // A machine with the client on PATH, described rather than touched, so these
  // assertions do not depend on where OpenSSH happens to be installed.
  const windowsBox = {
    platform: 'win32' as const,
    path: 'C:\\Windows\\System32;C:\\Windows\\System32\\OpenSSH',
    pathExt: '.EXE;.CMD',
    isFile: (candidate: string) => candidate === 'C:\\Windows\\System32\\OpenSSH\\sftp.EXE'
  };
  const unixBox = {
    platform: 'linux' as const,
    path: '/usr/local/bin:/usr/bin',
    isFile: (candidate: string) => candidate === '/usr/bin/sftp'
  };

  it('builds the client invocation from a validated target', () => {
    expect(buildSftpArgs('dev@example.com:2222', unixBox)).toEqual({
      file: '/usr/bin/sftp',
      args: ['-o', 'ConnectTimeout=20', '-P', '2222', 'dev@example.com']
    });
    expect(buildSftpArgs('example.com', unixBox).args).toEqual(['-o', 'ConnectTimeout=20', 'example.com']);
    // A destination ssh would read as an option must not reach sftp either.
    expect(() => buildSftpArgs('-oProxyCommand=touch /tmp/pwned', unixBox)).toThrow();
    expect(() => buildSftpArgs('example.com; rm -rf /', unixBox)).toThrow();
  });

  it('resolves the client to a path a pty can start', () => {
    // node-pty hands the file to CreateProcess, which does not append `.exe`, so
    // spawning a bare `sftp` fails on a Windows machine that plainly has it.
    expect(sftpExecutable(windowsBox)).toBe('C:\\Windows\\System32\\OpenSSH\\sftp.EXE');
    expect(sftpExecutable(unixBox)).toBe('/usr/bin/sftp');
  });

  it('says the client is missing, rather than letting the pty say "File not found"', () => {
    expect(() => sftpExecutable({ ...unixBox, isFile: () => false })).toThrow(/OpenSSH sftp client was not found/);
  });
});

describe('reading the client', () => {
  it('recognises the prompt through terminal repainting', () => {
    expect(endsWithPrompt(`${ESC}[?2004hsftp> `)).toBe(true);
    expect(endsWithPrompt('Connected to example.com.\r\n')).toBe(false);
  });

  it('drops the echoed command and the trailing prompt', () => {
    expect(responseBody('pwd\r\nRemote working directory: /home/dev\r\nsftp> ', 'pwd')).toBe('Remote working directory: /home/dev');
  });

  it('parses a long listing, spaces and symlinks included', () => {
    const output = [
      'drwxr-xr-x    5 1000     1000         4096 Aug 18 09:12 .',
      'drwxr-xr-x   22 1000     1000         4096 Aug 10 11:03 ..',
      '-rw-r--r--    1 1000     1000         1234 Aug 18 12:34 release notes.md',
      'drwxr-xr-x    2 1000     1000         4096 Jul  2  2024 build',
      'lrwxrwxrwx    1 1000     1000           11 Aug  1 08:00 current -> releases/7',
      '-rw-r--r--    1 0        0          204800 Aug 19 07:41 app.tar.gz'
    ].join('\n');
    const entries = parseListing(output);
    // `.` and `..` are navigation, not files, and the panel has its own control.
    expect(entries.map((entry) => entry.name)).toEqual(['release notes.md', 'build', 'current', 'app.tar.gz']);
    expect(entries[0]).toMatchObject({ kind: 'file', size: 1234, modified: 'Aug 18 12:34' });
    expect(entries[1].kind).toBe('directory');
    expect(entries[2]).toMatchObject({ kind: 'symlink', linkTarget: 'releases/7' });
  });

  it('parses a listing from a server that formats its columns differently', () => {
    // Verified against OpenSSH's MSYS sftp-server, which prints a masked mode
    // and no link count at all. The columns the panel reads are still there, so
    // the pane must fill rather than come back empty.
    const entries = parseListing([
      'drwx******    ? 2751     513             0 Aug 19 10:23 .claude',
      '-rw-******    ? 2751     513          7293 Aug 13 10:01 CONTEXT.md'
    ].join('\n'));
    expect(entries).toMatchObject([
      { name: '.claude', kind: 'directory' },
      { name: 'CONTEXT.md', kind: 'file', size: 7293 }
    ]);
  });

  it('reads the working directory the server reported', () => {
    expect(parsePwd('Remote working directory: /var/www/app')).toBe('/var/www/app');
    expect(parsePwd('ls -lan')).toBeNull();
  });

  it('finds failures, and does not invent them from filenames', () => {
    expect(findError("Couldn't stat remote file: No such file or directory")).toMatch(/Couldn't stat/);
    expect(findError('remote readdir("/nope"): No such file or directory')).toMatch(/readdir/);
    expect(findError('rm /srv/app.log: Permission denied')).toMatch(/Permission denied/);
    expect(findError('Remote working directory: /home/dev')).toBeNull();
    // A file really can be called this; it is a listing row, not a message.
    expect(findError('-rw-r--r--    1 1000     1000            0 Aug 19 07:41 Permission denied')).toBeNull();
  });

  it('reads the progress meter the pty made the client print', () => {
    expect(parseProgress('app.tar.gz                                    40%   80MB   9.7MB/s   00:12 ETA')).toEqual({
      name: 'app.tar.gz',
      percent: 40,
      detail: '80MB   9.7MB/s   00:12 ETA'
    });
    // Frames overwrite each other, so the newest one in the chunk is the answer.
    expect(parseProgress('app.zip     10%  1MB\rapp.zip     100% 12MB   4.0MB/s   00:03')?.percent).toBe(100);
    expect(parseProgress('sftp> ')).toBeNull();
  });

  it('recognises the questions only a pty lets the client ask', () => {
    expect(detectPrompt("dev@example.com's password: ")).toMatchObject({ kind: 'password' });
    expect(detectPrompt("Enter passphrase for key '/home/dev/.ssh/id_ed25519': ")).toMatchObject({ kind: 'passphrase' });
    const authenticity = [
      "The authenticity of host 'example.com (203.0.113.7)' can't be established.",
      'ED25519 key fingerprint is SHA256:abc123.',
      'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
    ].join('\r\n');
    const question = detectPrompt(authenticity);
    expect(question?.kind).toBe('confirm');
    // The fingerprint has to travel with the question: nobody can vouch for a
    // key they have not been shown.
    expect(question?.text).toContain('SHA256:abc123');
    expect(detectPrompt(`${ESC}]0;sftp${BEL}sftp> `)).toBeNull();
  });

  it('separates a dead connection from a failed command', () => {
    expect(detectFatal('ssh: connect to host example.com port 22: Connection refused')).toMatch(/Connection refused/);
    expect(detectFatal('Permission denied (publickey).')).toMatch(/publickey/);
    expect(detectFatal('Host key verification failed.')).toMatch(/verification failed/);
    expect(detectFatal("Couldn't stat remote file: No such file or directory")).toBeNull();
  });

  it('keeps a directory row out of the listing when it is not one', () => {
    expect(parseLsLine('Connected to example.com.')).toBeNull();
    expect(parseLsLine('')).toBeNull();
  });
});
