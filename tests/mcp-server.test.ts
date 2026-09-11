import { afterEach, describe, expect, it } from 'vitest';
import { McpServerHost } from '../src/main/mcp-server';

const hosts: McpServerHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});

describe('MCP server host', () => {
  it('requires the generated bearer token before serving MCP', async () => {
    const host = new McpServerHost({
      port: 0,
      token: 'test-token',
      providers: { listWorkspaces: async () => [], listSessions: async () => [] }
    });
    hosts.push(host);
    const info = await host.start();

    const denied = await fetch(info.endpoint, { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);

    const response = await fetch(info.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    });
    expect(response.status).toBe(200);
    expect((await response.json()).result.serverInfo.name).toBe('zerogterm');
  });
});
