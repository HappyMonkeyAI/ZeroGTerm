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

  it('exposes SSH session creation behind the session:create capability', async () => {
    let requested: { target: string; name?: string } | undefined;
    const host = new McpServerHost({
      port: 0,
      token: 'test-token',
      providers: {
        listWorkspaces: async () => [],
        listSessions: async () => [],
        createSshSession: async (request) => { requested = request; return { id: 'ssh-1', ...request }; }
      }
    });
    hosts.push(host);
    const info = await host.start();
    const headers = { Authorization: `Bearer ${info.token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    const rpc = async (id: number, method: string, params: unknown) => (await fetch(info.endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();

    const tools = await rpc(1, 'tools/list', {}) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.some((tool) => tool.name === 'zerog_create_ssh_session')).toBe(true);
    await rpc(2, 'tools/call', { name: 'zerog_acquire_control', arguments: { clientId: 'ssh-client', capabilities: ['session:create'] } });
    const result = await rpc(3, 'tools/call', { name: 'zerog_create_ssh_session', arguments: { clientId: 'ssh-client', target: '192.168.5.215', name: 'build-host' } });
    expect(result).toMatchObject({ result: { content: [{ text: JSON.stringify({ id: 'ssh-1', target: '192.168.5.215', name: 'build-host' }) }] } });
    expect(requested).toEqual({ target: '192.168.5.215', name: 'build-host' });
  });

  it('exposes blank workspace creation behind the workspace:write capability', async () => {
    let created = false;
    const host = new McpServerHost({
      port: 0,
      token: 'test-token',
      providers: {
        listWorkspaces: async () => [],
        listSessions: async () => [],
        createWorkspace: async () => { created = true; return { workspaceId: 'ws-1', workspaceName: 'workspace-2', restored: [] }; }
      }
    });
    hosts.push(host);
    const info = await host.start();
    const headers = { Authorization: `Bearer ${info.token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    const rpc = async (id: number, method: string, params: unknown) => (await fetch(info.endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();
    await rpc(1, 'tools/call', { name: 'zerog_acquire_control', arguments: { clientId: 'workspace-client', capabilities: ['workspace:write'] } });
    const result = await rpc(2, 'tools/call', { name: 'zerog_create_workspace', arguments: { clientId: 'workspace-client' } });
    expect(result).toMatchObject({ result: { content: [{ text: JSON.stringify({ workspaceId: 'ws-1', workspaceName: 'workspace-2', restored: [] }) }] } });
    expect(created).toBe(true);
  });

  it('allows the current client to upgrade its lease capabilities', async () => {
    const host = new McpServerHost({
      port: 0,
      token: 'test-token',
      providers: { listWorkspaces: async () => [], listSessions: async () => [] }
    });
    hosts.push(host);
    const info = await host.start();
    const headers = { Authorization: `Bearer ${info.token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
    const rpc = async (id: number, method: string, params: unknown) => (await fetch(info.endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json();

    const tools = await rpc(1, 'tools/list', {}) as { result: { tools: Array<{ name: string }> } };
    expect(tools.result.tools.some((tool) => tool.name === 'zerog_upgrade_control')).toBe(true);
    await rpc(2, 'tools/call', { name: 'zerog_acquire_control', arguments: { clientId: 'upgrade-client', capabilities: ['session:read'] } });
    const result = await rpc(3, 'tools/call', { name: 'zerog_upgrade_control', arguments: { clientId: 'upgrade-client', capabilities: ['workspace:read', 'workspace:write'] } });
    expect(result).toMatchObject({ result: { content: [{ text: expect.stringContaining('workspace:write') }] } });
  });
});
