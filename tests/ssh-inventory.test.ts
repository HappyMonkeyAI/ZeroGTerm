import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildRemoteScreenAttachArgs,
  buildRemoteScreenDiscoveryArgs,
  parseRemoteScreenList,
  parseSshConfig,
  validateKnownConnection,
} from '../src/main/ssh-inventory';

describe('SSH config inventory', () => {
  it('parses aliases, first values, metadata, and skips wildcard-only hosts', () => {
    const config = readFileSync(new URL('./fixtures/ssh-config.fixture', import.meta.url), 'utf8');
    expect(parseSshConfig(config, '/home/alice/.ssh/config')).toEqual([
      {
        alias: 'dev', hostName: 'bastion.example.com', user: 'alice', port: 2222,
        identityFile: '~/.ssh/id_ed25519', source: '/home/alice/.ssh/config',
      },
      {
        alias: 'staging', hostName: 'bastion.example.com', user: 'alice', port: 2222,
        identityFile: '~/.ssh/id_ed25519', source: '/home/alice/.ssh/config',
      },
      { alias: 'plain', hostName: 'plain.example.com', user: 'bob', port: 2200, source: '/home/alice/.ssh/config' },
      { alias: 'alias-only', source: '/home/alice/.ssh/config' },
      { alias: 'exact', hostName: 'mixed.example.com', source: '/home/alice/.ssh/config' },
      { alias: 'escaped', hostName: 'quoted.example.com', identityFile: '/home/alice/.ssh/key with spaces', source: '/home/alice/.ssh/config' },
    ]);
  });

  it('accepts only safe structured connection data', () => {
    expect(validateKnownConnection({ alias: 'dev', hostName: 'example.com', user: 'alice', port: 22 })).toEqual({ alias: 'dev', hostName: 'example.com', user: 'alice', port: 22 });
    expect(() => validateKnownConnection({ alias: 'dev;rm', hostName: 'example.com' })).toThrow();
    expect(() => validateKnownConnection({ alias: 'dev', hostName: 'example.com', port: 0 })).toThrow();
  });

  it('rejects connection fields that ssh would parse as options', () => {
    // user is concatenated into `user@host`, so a leading '-' makes the whole
    // destination an option: `-Fevil.cfg@host` reads an attacker-chosen config.
    expect(() => validateKnownConnection({ alias: 'dev', hostName: 'example.com', user: '-Fevil.cfg' })).toThrow();
    expect(() => validateKnownConnection({ alias: '-Fevil.cfg' })).toThrow();
    expect(() => validateKnownConnection({ alias: 'dev', hostName: '-Fevil.cfg' })).toThrow();
    expect(buildRemoteScreenDiscoveryArgs({ alias: 'dev', hostName: 'example.com', user: 'alice' }).args).toContain('alice@example.com');
  });
});

describe('remote screen contract', () => {
  it('parses host-qualified stable IDs', () => {
    const sessions = parseRemoteScreenList('There are screens on:\n\t1234.work\t(Detached)\n\t5678.ops\t(Attached)\n', 'dev');
    expect(sessions.map((s) => ({ id: s.id, name: s.screenName, status: s.status }))).toEqual([
      { id: 'remote:dev:work', name: 'work', status: 'detached' },
      { id: 'remote:dev:ops', name: 'ops', status: 'connected' },
    ]);
  });

  it('constructs constrained argv-only SSH screen commands', () => {
    expect(buildRemoteScreenDiscoveryArgs({ alias: 'dev', hostName: 'example.com', user: 'alice', port: 2222 })).toEqual({
      file: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-p', '2222', '--', 'alice@example.com', 'screen', '-ls'],
    });
    expect(buildRemoteScreenAttachArgs({ alias: 'dev', hostName: 'example.com', user: 'alice' }, 'work')).toEqual({
      file: 'ssh', args: ['-tt', '--', 'alice@example.com', 'screen', '-x', 'work'],
    });
    expect(() => buildRemoteScreenAttachArgs({ alias: 'dev', hostName: 'example.com' }, 'bad name')).toThrow();
  });
});

 it('reads timestamped listings and excludes dead sockets', () => {
   const items = parseRemoteScreenList('123.work (10/15/26 12:34:56) (Attached)\n456.other (10/15/26 12:34:56) (Detached)\n789.old (Dead ???)', 'dev');
   expect(items.map(s => [s.screenName, s.status])).toEqual([['work', 'connected'], ['other', 'detached']]);
 });
 it('retains the SSH alias for identity files and jump hosts', () => {
   expect(buildRemoteScreenDiscoveryArgs({ alias: 'dev', hostName: 'internal', source: 'config' }).args).toContain('dev');
 });
