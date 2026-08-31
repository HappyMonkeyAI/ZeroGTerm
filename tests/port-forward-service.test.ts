import { describe, expect, it } from 'vitest';
import { createFakePty } from './helpers/fake-pty';
import { PortForwardService } from '../src/main/port-forward-service';
import type { PortForwardEvent, PortForwardRequest } from '../src/shared/types';

/** Let every pending microtask run, so the service has read what was emitted. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const LOCAL_OPEN = 'debug1: Authentication succeeded (publickey).\r\ndebug1: Local forwarding listening on 127.0.0.1 port 3000.\r\n';

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

function harness() {
  const { spawn, spawned } = createFakePty();
  const events: PortForwardEvent[] = [];
  // A short settle so the authenticated-but-quiet fallback can be exercised
  // without the test waiting out the real one.
  const service = new PortForwardService({ spawnPty: spawn, onEvent: (event) => events.push(event), settleMs: 20 });
  return { service, spawned, events };
}

describe('opening a shared port', () => {
  it('starts the system client with the built spec', async () => {
    const { service, spawned } = harness();
    const opening = service.open(request());
    await settle();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain('-L');
    expect(spawned[0].args[spawned[0].args.indexOf('-L') + 1]).toBe('127.0.0.1:3000:localhost:3000');
    spawned[0].emit(LOCAL_OPEN);
    await expect(opening).resolves.toMatchObject({ status: 'open' });
  });

  it('reports connecting before it reports open', async () => {
    const { service, spawned, events } = harness();
    const opening = service.open(request());
    await settle();
    expect(events.filter((e) => e.type === 'status').map((e) => e.type === 'status' && e.forward.status)).toEqual(['connecting']);
    spawned[0].emit(LOCAL_OPEN);
    await opening;
    const statuses = events.filter((e) => e.type === 'status').map((e) => e.type === 'status' && e.forward.status);
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('lists a tunnel only while it is live', async () => {
    const { service, spawned } = harness();
    const opening = service.open(request());
    await settle();
    spawned[0].emit(LOCAL_OPEN);
    const info = await opening;
    expect(service.list().map((item) => item.id)).toEqual([info.id]);
    service.close(info.id);
    expect(service.list()).toEqual([]);
  });

  it('recognises a remote forward being accepted', async () => {
    const { service, spawned } = harness();
    const opening = service.open(request({ direction: 'remote', listenPort: 8080 }));
    await settle();
    expect(spawned[0].args).toContain('-R');
    spawned[0].emit('debug1: remote forward success for: listen 8080, connect localhost:3000\r\n');
    await expect(opening).resolves.toMatchObject({ status: 'open' });
  });

  it('takes silence after authentication as success', async () => {
    // An ssh build may word the listening line differently from the one this was
    // written against; failing a working tunnel over that would be worse.
    const { service, spawned } = harness();
    const opening = service.open(request());
    await settle();
    spawned[0].emit('debug1: Authentication succeeded (publickey).\r\n');
    await expect(opening).resolves.toMatchObject({ status: 'open' });
  });

  it('rejects an invalid request without spawning anything', async () => {
    const { service, spawned } = harness();
    await expect(service.open(request({ listenPort: 0 }))).rejects.toThrow(/between 1 and 65535/);
    expect(spawned).toEqual([]);
  });
});

describe('a shared port that cannot open', () => {
  it('fails with the address it could not bind', async () => {
    const { service, spawned } = harness();
    const opening = service.open(request());
    await settle();
    spawned[0].emit('bind [127.0.0.1]:3000: Address already in use\r\n');
    await expect(opening).rejects.toThrow(/127\.0\.0\.1:3000/);
    expect(service.list()).toEqual([]);
  });

  it('kills the client rather than leaving it connected', async () => {
    // ExitOnForwardFailure should make ssh exit on its own, but a client that
    // does not must not be left running with no tunnel and no row.
    const { service, spawned } = harness();
    const opening = service.open(request());
    await settle();
    spawned[0].emit('bind [127.0.0.1]:3000: Address already in use\r\n');
    await opening.catch(() => undefined);
    expect(spawned[0].killed).toBe(true);
  });

  it('reports the error status before dropping the tunnel', async () => {
    const { service, spawned, events } = harness();
    const opening = service.open(request());
    await settle();
    spawned[0].emit('Permission denied (publickey,password).\r\n');
    await opening.catch(() => undefined);
    const errors = events.filter((e) => e.type === 'status' && e.forward.status === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].type === 'status' && errors[0].forward.message).toMatch(/Authentication failed/);
  });

  it('explains a client that exits without saying why', async () => {
    const { service, spawned } = harness();
    const opening = service.open(request());
    await settle();
    spawned[0].exit();
    await expect(opening).rejects.toThrow(/Could not share port 3000/);
  });

  it('reads the buffer once more when the client exits', async () => {
    // With ExitOnForwardFailure, exiting is how a failed bind reports itself, so
    // the reason is in what it already said rather than in the exit itself.
    const { service, spawned } = harness();
    const opening = service.open(request({ direction: 'remote', listenPort: 8080 }));
    await settle();
    spawned[0].emit('Warning: remote port forwarding failed for listen port 8080\r\n');
    await expect(opening).rejects.toThrow(/GatewayPorts/);
  });
});

describe('answering the client', () => {
  it('surfaces a password prompt and writes the answer back', async () => {
    const { service, spawned, events } = harness();
    const opening = service.open(request());
    await settle();
    spawned[0].emit("dev@build.example.com's password: ");
    await settle();
    const prompt = events.find((event) => event.type === 'prompt');
    expect(prompt).toMatchObject({ type: 'prompt', prompt: { kind: 'password' } });

    const id = prompt?.type === 'prompt' ? prompt.forwardId : '';
    service.answerPrompt(id, 'hunter2');
    expect(spawned[0].writes).toEqual(['hunter2\n']);

    spawned[0].emit(`\r\n${LOCAL_OPEN}`);
    await expect(opening).resolves.toMatchObject({ status: 'open' });
  });

  it('asks again when the same question comes back', async () => {
    // A rejected password is followed by the very same prompt text, and the user
    // has to be given the field again.
    const { service, spawned, events } = harness();
    void service.open(request()).catch(() => undefined);
    await settle();
    spawned[0].emit("dev@build.example.com's password: ");
    await settle();
    const id = events.find((e) => e.type === 'prompt')?.type === 'prompt'
      ? (events.find((e) => e.type === 'prompt') as { forwardId: string }).forwardId
      : '';
    service.answerPrompt(id, 'wrong');
    spawned[0].emit("\r\nPermission denied, please try again.\r\ndev@build.example.com's password: ");
    await settle();
    expect(events.filter((event) => event.type === 'prompt')).toHaveLength(2);
  });

  it('refuses a multi-line answer', async () => {
    const { service, spawned } = harness();
    const opening = service.open(request());
    await settle();
    spawned[0].emit(LOCAL_OPEN);
    const info = await opening;
    expect(() => service.answerPrompt(info.id, 'one\ntwo')).toThrow(/single line/);
  });

  it('refuses to answer a tunnel that has gone', async () => {
    const { service } = harness();
    expect(() => service.answerPrompt('forward:missing', 'x')).toThrow(/no longer open/);
  });
});

describe('conflicts and limits', () => {
  async function opened(service: PortForwardService, spawned: ReturnType<typeof createFakePty>['spawned'], overrides?: Partial<PortForwardRequest>) {
    const opening = service.open(request(overrides));
    await settle();
    spawned[spawned.length - 1].emit(LOCAL_OPEN);
    return opening;
  }

  it('refuses a second local forward on a port already shared', async () => {
    // Two listeners on one local port cannot both work; saying so beats letting
    // ssh fail a moment later.
    const { service, spawned } = harness();
    await opened(service, spawned);
    await expect(service.open(request({ target: 'other.example.com' }))).rejects.toThrow(/already shared/);
    expect(spawned).toHaveLength(1);
  });

  it('allows the same local port number as a remote forward', async () => {
    // A local forward binds here and a remote one binds on the far host, so the
    // numbers do not collide.
    const { service, spawned } = harness();
    await opened(service, spawned);
    const opening = service.open(request({ direction: 'remote' }));
    await settle();
    spawned[1].emit('debug1: remote forward success for: listen 3000, connect localhost:3000\r\n');
    await expect(opening).resolves.toMatchObject({ status: 'open' });
  });

  it('allows the same remote port on two different hosts', async () => {
    const { service, spawned } = harness();
    const first = service.open(request({ direction: 'remote', listenPort: 8080 }));
    await settle();
    spawned[0].emit('debug1: remote forward success for: listen 8080, connect localhost:3000\r\n');
    await first;
    const second = service.open(request({ direction: 'remote', listenPort: 8080, target: 'other.example.com' }));
    await settle();
    spawned[1].emit('debug1: remote forward success for: listen 8080, connect localhost:3000\r\n');
    await expect(second).resolves.toMatchObject({ status: 'open' });
  });

  it('refuses the same remote port twice on one host', async () => {
    const { service, spawned } = harness();
    const first = service.open(request({ direction: 'remote', listenPort: 8080 }));
    await settle();
    spawned[0].emit('debug1: remote forward success for: listen 8080, connect localhost:3000\r\n');
    await first;
    await expect(service.open(request({ direction: 'remote', listenPort: 8080 }))).rejects.toThrow(/already shared/);
  });

  it('lets a remembered forward reclaim its own id and port', async () => {
    // Reconnecting a ghost row passes the stored id back; that must not read as
    // a conflict with itself.
    const { service, spawned } = harness();
    const opening = service.open(request({ id: 'forward:stored' }));
    await settle();
    spawned[0].emit(LOCAL_OPEN);
    const info = await opening;
    expect(info.id).toBe('forward:stored');
    service.close(info.id);
    const again = service.open(request({ id: 'forward:stored' }));
    await settle();
    spawned[1].emit(LOCAL_OPEN);
    await expect(again).resolves.toMatchObject({ id: 'forward:stored', status: 'open' });
  });

  it('closes every tunnel on shutdown', async () => {
    const { service, spawned } = harness();
    await opened(service, spawned);
    await opened(service, spawned, { listenPort: 3001, destinationPort: 3001 });
    service.closeAll();
    expect(spawned.map((pty) => pty.killed)).toEqual([true, true]);
    expect(service.list()).toEqual([]);
  });

  it('ignores closing something already gone', () => {
    const { service } = harness();
    expect(() => service.close('forward:missing')).not.toThrow();
  });
});
