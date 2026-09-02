import { describe, expect, it } from 'vitest';
import { buildForwardArgs, describeForward, readForwardOutcome } from '../src/main/port-forward-protocol';
import type { PortForwardRequest } from '../src/shared/types';

function request(overrides: Partial<PortForwardRequest> = {}): PortForwardRequest {
  return {
    target: 'dev@build.example.com',
    direction: 'local',
    listenPort: 3000,
    destinationPort: 3000,
    bind: 'loopback',
    ...overrides
  };
}

/** The -L/-R value, whichever flag carried it. */
function specOf(args: string[]): string {
  const index = args.findIndex((arg) => arg === '-L' || arg === '-R');
  return args[index + 1];
}

describe('buildForwardArgs', () => {
  it('refuses to let a failed forward look like a working one', () => {
    // Without ExitOnForwardFailure, ssh stays connected when the bind fails and
    // there is no way to tell a live tunnel from a dead one.
    expect(buildForwardArgs(request()).args).toContain('ExitOnForwardFailure=yes');
  });

  it('asks the client to report what it is doing', () => {
    // -N produces no output on success, so without -v the only available signal
    // is the absence of an error.
    expect(buildForwardArgs(request()).args).toContain('-v');
    expect(buildForwardArgs(request()).args).toContain('-N');
  });

  it('does not ask for a remote tty', () => {
    // -N means no remote command; a tty for it would be meaningless.
    const { args } = buildForwardArgs(request());
    expect(args).not.toContain('-t');
    expect(args).not.toContain('-tt');
  });

  it('binds a local forward to loopback by default', () => {
    const { args } = buildForwardArgs(request());
    expect(specOf(args)).toBe('127.0.0.1:3000:localhost:3000');
    expect(args.slice(args.indexOf('-L') - 1, args.indexOf('-L'))).not.toContain('-R');
  });

  it('widens a local forward only when asked', () => {
    expect(specOf(buildForwardArgs(request({ bind: 'all' })).args)).toBe('0.0.0.0:3000:localhost:3000');
  });

  it('says nothing about the bind address for a loopback remote forward', () => {
    // sshd's default GatewayPorts binds loopback and rejects a client-specified
    // address outright, so loopback has to be expressed by omission.
    const { args } = buildForwardArgs(request({ direction: 'remote', listenPort: 8080, destinationPort: 3000 }));
    expect(args).toContain('-R');
    expect(specOf(args)).toBe('8080:localhost:3000');
  });

  it('uses a wildcard for a wide remote forward', () => {
    // '*' is accepted under both GatewayPorts yes and clientspecified.
    const { args } = buildForwardArgs(request({ direction: 'remote', bind: 'all', listenPort: 8080 }));
    expect(specOf(args)).toBe('*:8080:localhost:3000');
  });

  it('carries the SSH port and ends option parsing before the destination', () => {
    const { args } = buildForwardArgs(request({ target: 'dev@build.example.com:2222' }));
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('dev@build.example.com');
  });

  it('forwards to another host on the far side when told to', () => {
    const { args } = buildForwardArgs(request({ destinationHost: 'db.internal', destinationPort: 5432 }));
    expect(specOf(args)).toBe('127.0.0.1:3000:db.internal:5432');
  });

  it('rejects ports outside the usable range', () => {
    expect(() => buildForwardArgs(request({ listenPort: 0 }))).toThrow(/between 1 and 65535/);
    expect(() => buildForwardArgs(request({ listenPort: 65536 }))).toThrow(/between 1 and 65535/);
    expect(() => buildForwardArgs(request({ destinationPort: -1 }))).toThrow(/between 1 and 65535/);
    expect(() => buildForwardArgs(request({ listenPort: 80.5 }))).toThrow(/whole number/);
  });

  it('rejects a port that is not a number at all', () => {
    expect(() => buildForwardArgs(request({ listenPort: '3000' as unknown as number }))).toThrow(/whole number/);
  });

  it('rejects a destination host that ssh would read as an option', () => {
    // The host is concatenated into the forward spec, which is one argv element.
    expect(() => buildForwardArgs(request({ destinationHost: '-oProxyCommand=evil' }))).toThrow(/hostname or IP/);
  });

  it('rejects a destination host carrying whitespace or a newline', () => {
    expect(() => buildForwardArgs(request({ destinationHost: 'host evil' }))).toThrow(/hostname or IP/);
    expect(() => buildForwardArgs(request({ destinationHost: 'host\nevil' }))).toThrow(/hostname or IP/);
  });

  it('rejects a colon in the destination host rather than building a different tunnel', () => {
    // ssh splits a forward spec on colons, so 'host:22' would shift every field
    // along and describe a tunnel nobody asked for. An IPv6 literal has the same
    // problem unbracketed, and is refused by name so the message is useful.
    expect(() => buildForwardArgs(request({ destinationHost: 'host:22' }))).toThrow(/IPv6|hostname/);
    expect(() => buildForwardArgs(request({ destinationHost: '::1' }))).toThrow(/hostname or IP/);
    expect(() => buildForwardArgs(request({ destinationHost: 'fd00::1' }))).toThrow(/IPv6 destination is not supported/);
  });

  it('rejects an unknown direction or bind', () => {
    expect(() => buildForwardArgs(request({ direction: 'sideways' as never }))).toThrow(/local or remote/);
    expect(() => buildForwardArgs(request({ bind: 'everywhere' as never }))).toThrow(/loopback or to all/);
  });

  it('rejects a target that is not one', () => {
    expect(() => buildForwardArgs(request({ target: '-oProxyCommand=evil' }))).toThrow();
    expect(() => buildForwardArgs(request({ target: '' }))).toThrow();
  });
});

describe('readForwardOutcome', () => {
  it('says nothing while the client is still talking', () => {
    expect(readForwardOutcome('debug1: Reading configuration data /etc/ssh/ssh_config\r\n', 'local')).toBeNull();
  });

  it('recognises a local forward listening', () => {
    const output = 'debug1: Authentication succeeded (publickey).\r\ndebug1: Local forwarding listening on 127.0.0.1 port 3000.\r\n';
    expect(readForwardOutcome(output, 'local')).toEqual({ kind: 'open' });
  });

  it('recognises a remote forward being accepted', () => {
    const output = 'debug1: remote forward success for: listen 8080, connect localhost:3000\r\n';
    expect(readForwardOutcome(output, 'remote')).toEqual({ kind: 'open' });
  });

  it('does not read a local success as a remote one', () => {
    // The two directions have different success lines; crossing them would
    // report a tunnel the far side never agreed to.
    const output = 'debug1: Local forwarding listening on 127.0.0.1 port 3000.\r\n';
    expect(readForwardOutcome(output, 'remote')).toBeNull();
  });

  it('reports a local port already in use, with the address', () => {
    const output = 'bind [127.0.0.1]:3000: Address already in use\r\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 3000\r\n';
    const outcome = readForwardOutcome(output, 'local');
    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(outcome?.kind === 'failed' && outcome.reason).toContain('127.0.0.1:3000');
    expect(outcome?.kind === 'failed' && outcome.reason).toContain('Address already in use');
  });

  it('explains a refused remote forward in terms of GatewayPorts', () => {
    // The overwhelmingly common cause, and not guessable from sshd's own wording.
    const outcome = readForwardOutcome('Warning: remote port forwarding failed for listen port 8080\r\n', 'remote');
    expect(outcome?.kind === 'failed' && outcome.reason).toMatch(/GatewayPorts/);
  });

  it('reports authentication and host failures', () => {
    expect(readForwardOutcome('Permission denied (publickey,password).', 'local')).toMatchObject({ kind: 'failed' });
    expect(readForwardOutcome('ssh: Could not resolve hostname nope: Name or service not known', 'local'))
      .toMatchObject({ kind: 'failed', reason: 'Could not resolve nope.' });
    expect(readForwardOutcome('Host key verification failed.', 'local')).toMatchObject({ kind: 'failed' });
  });

  it('prefers a failure over a success that came before it', () => {
    // ssh reports one forward of several succeeding and still exits, so a
    // success line is not proof the process is going to survive.
    const output = 'debug1: Local forwarding listening on 127.0.0.1 port 3000.\r\nbind [127.0.0.1]:3001: Address already in use\r\n';
    expect(readForwardOutcome(output, 'local')).toMatchObject({ kind: 'failed' });
  });

  it('reports authentication on its own as not yet open', () => {
    const outcome = readForwardOutcome('debug1: Authentication succeeded (publickey).\r\n', 'local');
    expect(outcome).toEqual({ kind: 'authenticated' });
  });
});

describe('describeForward', () => {
  it('reads in the direction the traffic travels', () => {
    expect(describeForward(request())).toBe('localhost:3000 → localhost:3000 on dev@build.example.com');
    expect(describeForward(request({ bind: 'all' }))).toMatch(/^0\.0\.0\.0:3000/);
    expect(describeForward(request({ direction: 'remote', listenPort: 8080 })))
      .toBe('dev@build.example.com:8080 → localhost:3000 here');
  });
});
