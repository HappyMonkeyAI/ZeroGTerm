import { describe, expect, it } from 'vitest';
import {
  applyForwardStatus,
  forwardConflict,
  forwardDotState,
  forwardLabel,
  fromStoredForwards,
  groupForwards,
  isWidelyBound,
  listenerLabel,
  toStoredForwards
} from '../src/renderer/port-forwards';
import type { PortForwardInfo } from '../src/shared/types';

function forward(overrides: Partial<PortForwardInfo> = {}): PortForwardInfo {
  return {
    id: overrides.id ?? 'forward:1',
    target: 'dev@build.example.com',
    direction: 'local',
    listenPort: 3000,
    destinationPort: 3000,
    bind: 'loopback',
    status: 'open',
    ...overrides
  };
}

describe('groupForwards', () => {
  it('groups on the bare hostname, so one host is one heading', () => {
    // A target may carry a user and a port; the host is what the user recognises.
    const forwards = [
      forward({ id: 'a', target: 'dev@build.example.com:2222' }),
      forward({ id: 'b', target: 'build.example.com' }),
      forward({ id: 'c', target: 'db.example.com' })
    ];
    const groups = groupForwards(forwards);
    expect(groups.map((group) => group.host)).toEqual(['build.example.com', 'db.example.com']);
    expect(groups[0].forwards.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('orders hosts by first appearance, so the list does not reshuffle', () => {
    const groups = groupForwards([forward({ id: 'a', target: 'z.example.com' }), forward({ id: 'b', target: 'a.example.com' })]);
    expect(groups.map((group) => group.host)).toEqual(['z.example.com', 'a.example.com']);
  });

  it('is empty for nothing', () => {
    expect(groupForwards([])).toEqual([]);
  });
});

describe('forwardDotState', () => {
  it('reuses the session dot vocabulary', () => {
    expect(forwardDotState(forward({ status: 'open' }))).toBe('connected');
    expect(forwardDotState(forward({ status: 'connecting' }))).toBe('detached');
    expect(forwardDotState(forward({ status: 'error' }))).toBe('error');
    expect(forwardDotState(forward({ status: 'idle' }))).toBe('');
  });
});

describe('forwardLabel and listenerLabel', () => {
  it('reads in the direction traffic travels for a local forward', () => {
    expect(forwardLabel(forward())).toBe('localhost:3000 → localhost:3000');
    expect(forwardLabel(forward({ destinationHost: 'db.internal', destinationPort: 5432 })))
      .toBe('localhost:3000 → db.internal:5432');
  });

  it('says where a remote forward listens, which is not this machine', () => {
    // Getting the direction the wrong way round is the easiest mistake here, so
    // the row names the far host rather than leaving 'localhost' to be misread.
    const remote = forward({ direction: 'remote', listenPort: 8080, destinationPort: 3000 });
    expect(listenerLabel(remote)).toBe('build.example.com:8080');
    expect(forwardLabel(remote)).toBe('build.example.com:8080 → localhost:3000 here');
  });

  it('shows a wide bind rather than leaving it to be worked out', () => {
    expect(listenerLabel(forward({ bind: 'all' }))).toBe('0.0.0.0:3000');
    expect(listenerLabel(forward({ direction: 'remote', bind: 'all', listenPort: 8080 })))
      .toBe('build.example.com (all):8080');
  });

  it('flags a wide bind as its own question', () => {
    expect(isWidelyBound(forward())).toBe(false);
    expect(isWidelyBound(forward({ bind: 'all' }))).toBe(true);
  });
});

describe('forwardConflict', () => {
  it('refuses a second local forward on a port already bound here', () => {
    const existing = [forward({ id: 'a' })];
    expect(forwardConflict(forward({ id: 'b', target: 'other.example.com' }), existing))
      .toMatch(/already shared from dev@build\.example\.com/);
  });

  it('allows the same number for a local and a remote forward', () => {
    // They bind on different machines.
    const existing = [forward({ id: 'a', direction: 'local' })];
    expect(forwardConflict(forward({ id: 'b', direction: 'remote' }), existing)).toBeNull();
  });

  it('allows the same remote port on two different hosts', () => {
    const existing = [forward({ id: 'a', direction: 'remote', listenPort: 8080 })];
    const request = forward({ id: 'b', direction: 'remote', listenPort: 8080, target: 'other.example.com' });
    expect(forwardConflict(request, existing)).toBeNull();
  });

  it('refuses the same remote port twice on one host, however it is written', () => {
    const existing = [forward({ id: 'a', direction: 'remote', listenPort: 8080, target: 'build.example.com' })];
    const request = forward({ id: 'b', direction: 'remote', listenPort: 8080, target: 'dev@build.example.com:2222' });
    expect(forwardConflict(request, existing)).toMatch(/already shared to/);
  });

  it('does not conflict with itself when a remembered forward reconnects', () => {
    const existing = [forward({ id: 'forward:stored', status: 'idle' })];
    expect(forwardConflict(forward({ id: 'forward:stored' }), existing)).toBeNull();
  });

  it('counts an idle remembered row as holding its port', () => {
    // It is about to be reconnected on the same port; offering the port to
    // something else would set up a clash a moment later.
    const existing = [forward({ id: 'a', status: 'idle' })];
    expect(forwardConflict(forward({ id: 'b' }), existing)).not.toBeNull();
  });
});

describe('applyForwardStatus', () => {
  it('replaces a row rather than adding a second one for the same tunnel', () => {
    // A tunnel reports itself several times on the way up.
    const forwards = [forward({ id: 'a', status: 'connecting' })];
    const next = applyForwardStatus(forwards, forward({ id: 'a', status: 'open' }));
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe('open');
  });

  it('adds a tunnel it has not seen', () => {
    expect(applyForwardStatus([], forward({ id: 'a' }))).toHaveLength(1);
  });

  it('leaves the original list alone', () => {
    const forwards = [forward({ id: 'a', status: 'connecting' })];
    applyForwardStatus(forwards, forward({ id: 'a', status: 'open' }));
    expect(forwards[0].status).toBe('connecting');
  });
});

describe('storing and restoring', () => {
  it('drops the status, which is a fact about now', () => {
    const stored = toStoredForwards([forward({ status: 'open', message: 'listening' })]);
    expect(stored.forwards[0]).not.toHaveProperty('status');
    expect(JSON.stringify(stored)).not.toContain('listening');
  });

  it('remembers a forward that never opened', () => {
    // The user asked for it; a host being down tonight is not a reason to forget.
    const stored = toStoredForwards([forward({ status: 'error', message: 'Authentication failed.' })]);
    expect(stored.forwards).toHaveLength(1);
  });

  it('brings everything back idle, whatever it was doing', () => {
    const restored = fromStoredForwards(toStoredForwards([forward({ status: 'open' }), forward({ id: 'b', status: 'error' })]));
    expect(restored.map((item) => item.status)).toEqual(['idle', 'idle']);
  });

  it('round-trips the fields a tunnel needs to be reopened', () => {
    const original = forward({ bind: 'all', destinationHost: 'db.internal', destinationPort: 5432, direction: 'remote', listenPort: 8080 });
    const restored = fromStoredForwards(toStoredForwards([original]))[0];
    expect(restored).toMatchObject({
      id: original.id,
      target: original.target,
      direction: 'remote',
      listenPort: 8080,
      destinationHost: 'db.internal',
      destinationPort: 5432,
      bind: 'all'
    });
  });
});
