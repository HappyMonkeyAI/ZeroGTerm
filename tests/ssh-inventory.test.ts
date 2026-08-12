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
      file: 'ssh', args: ['-p', '2222', 'alice@example.com', '--', 'screen', '-ls'],
    });
    expect(buildRemoteScreenAttachArgs({ alias: 'dev', hostName: 'example.com', user: 'alice' }, 'work')).toEqual({
      file: 'ssh', args: ['alice@example.com', '--', 'screen', '-x', 'work'],
    });
    expect(() => buildRemoteScreenAttachArgs({ alias: 'dev', hostName: 'example.com' }, 'bad name')).toThrow();
  });
});
