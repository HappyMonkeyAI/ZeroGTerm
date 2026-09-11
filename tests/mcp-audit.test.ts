import { describe, expect, it } from 'vitest';
import { McpAudit } from '../src/main/mcp-audit';

describe('MCP audit', () => {
  it('stores bounded non-secret summaries and hashes clients', () => {
    const audit = new McpAudit();
    audit.record({ at: 1, requestId: 'r1', clientId: 'client-secret-id', capability: 'session:execute', sessionId: 'local:1', state: 'requested', command: 'echo safe' });
    const event = audit.list()[0];
    expect(event.client).not.toContain('client-secret-id');
    expect(event.command).toBe('echo safe');
    expect(audit.list()).toHaveLength(1);
  });
  it('retains only the bounded history', () => {
    const audit = new McpAudit();
    for (let i = 0; i < 300; i++) audit.record({ at: i, requestId: `r${i}`, clientId: 'client', capability: 'session:execute', sessionId: 'local:1', state: 'completed', command: 'echo safe' });
    expect(audit.list()).toHaveLength(256);
    expect(audit.list()[0].requestId).toBe('r44');
  });
});
