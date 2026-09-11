import { describe, expect, it } from 'vitest';
import { validateMcpCommand } from '../src/main/mcp-execution-policy';
import { McpExecutionBroker } from '../src/main/mcp-execution-broker';

describe('MCP command policy', () => {
  const base = { command: 'echo hello', sessionKind: 'local' as const };
  it('allows a plain local command and returns a display form', () => {
    const result = validateMcpCommand(base);
    expect(result.allowed).toBe(true);
    expect(result.command).toBe('echo hello');
    expect(result.displayCommand).toBe('echo hello');
  });
  it.each(['echo hi\nwhoami', 'echo $TOKEN', 'echo hi | more', 'echo hi > out', '\u001b[31mwhoami'])('rejects unsafe command %j', (command) => {
    expect(validateMcpCommand({ ...base, command }).allowed).toBe(false);
  });
  it('rejects remote execution by default and redacts credential-like input', () => {
    expect(validateMcpCommand({ command: 'echo hi', sessionKind: 'ssh' }).reason).toMatch(/Remote/);
    const result = validateMcpCommand({ ...base, command: 'curl -H "Authorization: Bearer secret" https://example.test' });
    expect(result.allowed).toBe(false);
  });
});

describe('MCP execution broker', () => {
  it('creates a pending request and requires an explicit decision', () => {
    const broker = new McpExecutionBroker();
    const request = broker.create({ clientId: 'client', sessionId: 'local:one', sessionKind: 'local', command: 'echo approval', now: 1000 });
    expect(request.state).toBe('pending');
    expect(broker.get(request.requestId, 'client', 1001)).toMatchObject({ requestId: request.requestId, state: 'pending' });
    expect(broker.decide(request.requestId, 'client', 'approve', 1001).state).toBe('approved');
  });
  it('rejects duplicate pending requests for a session', () => {
    const broker = new McpExecutionBroker();
    broker.create({ clientId: 'client', sessionId: 'local:one', sessionKind: 'local', command: 'echo one' });
    expect(() => broker.create({ clientId: 'client', sessionId: 'local:one', sessionKind: 'local', command: 'echo two' })).toThrow(/already pending/);
  });
  it('expires approvals and revokes them with the lease', () => {
    const broker = new McpExecutionBroker();
    const request = broker.create({ clientId: 'client', sessionId: 'local:one', sessionKind: 'local', command: 'echo one', now: 1000, approvalTtlMs: 1000 });
    expect(broker.get(request.requestId, 'client', 2000)).toMatchObject({ state: 'timed-out' });
    const second = broker.create({ clientId: 'client', sessionId: 'local:two', sessionKind: 'local', command: 'echo two' });
    broker.revoke('client', 3000);
    expect(broker.get(second.requestId, 'client')).toMatchObject({ state: 'cancelled' });
  });
  it('does not allow another client to inspect or decide a request', () => {
    const broker = new McpExecutionBroker();
    const request = broker.create({ clientId: 'owner', sessionId: 'local:one', sessionKind: 'local', command: 'echo one' });
    expect(() => broker.get(request.requestId, 'other')).toThrow(/Unknown/);
    expect(() => broker.decide(request.requestId, 'other', 'approve')).toThrow(/Unknown/);
  });
  it('stores bounded execution output in the final result', () => {
    const broker = new McpExecutionBroker();
    const request = broker.create({ clientId: 'owner', sessionId: 'local:one', sessionKind: 'local', command: 'echo one' });
    broker.decide(request.requestId, 'owner', 'approve');
    broker.start(request.requestId);
    expect(broker.finishRunning(request.requestId, 'completed', 'hello\n', false, 'Command completed.', 2000)).toMatchObject({
      requestId: request.requestId,
      state: 'completed',
      output: 'hello\n'
    });
  });
  it('finalizes cancellation with no output and preserves ownership', () => {
    const broker = new McpExecutionBroker();
    const request = broker.create({ clientId: 'owner', sessionId: 'local:one', sessionKind: 'local', command: 'echo one' });
    broker.decide(request.requestId, 'owner', 'approve');
    broker.start(request.requestId);
    expect(broker.cancel(request.requestId, 'owner', 'Stopped by test.')).toMatchObject({ state: 'cancelled', message: 'Stopped by test.' });
    expect(() => broker.cancel(request.requestId, 'other')).toThrow(/Unknown/);
  });
  it('supports an explicit bounded-output failure result', () => {
    const broker = new McpExecutionBroker();
    const request = broker.create({ clientId: 'owner', sessionId: 'local:one', sessionKind: 'local', command: 'yes' });
    broker.decide(request.requestId, 'owner', 'approve');
    broker.start(request.requestId);
    expect(broker.finishRunning(request.requestId, 'failed', 'x'.repeat(16 * 1024), true, 'Output limit reached.')).toMatchObject({ state: 'failed', truncated: true, output: 'x'.repeat(16 * 1024) });
  });
});
