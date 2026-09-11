import { describe, expect, it } from 'vitest';
import {
  boundedDeadline,
  requireBoundedString,
  requireMcpCapability,
  requireWorkspaceName
} from '../src/main/mcp-protocol';
import { McpControl } from '../src/main/mcp-control';

describe('MCP argument validation', () => {
  it('accepts safe workspace names and rejects shell/control text', () => {
    expect(requireWorkspaceName('client-api 2')).toBe('client-api 2');
    expect(() => requireWorkspaceName('$(rm -rf /)')).toThrow();
    expect(() => requireWorkspaceName(`bad${String.fromCharCode(27)}name`)).toThrow();
  });

  it('bounds strings and deadlines', () => {
    expect(requireBoundedString('  ok  ', 'field')).toBe('ok');
    expect(() => requireBoundedString('x'.repeat(257), 'field')).toThrow(/too long/);
    expect(boundedDeadline(undefined)).toBe(10_000);
    expect(() => boundedDeadline(99)).toThrow();
  });

  it('requires a live lease and capability', () => {
    expect(() => requireMcpCapability(undefined, 'workspace:read')).toThrow(/lease/);
  });
});

describe('McpControl', () => {
  it('is disabled until explicitly enabled', () => {
    const control = new McpControl();
    expect(control.status().state).toBe('disabled');
    expect(() => control.connect('client', 'Hermes', ['workspace:read'])).toThrow(/disabled/);
  });

  it('allows one client to acquire and renew a lease', () => {
    let now = 1_000;
    const control = new McpControl({ now: () => now, leaseMs: 500 });
    control.enable('http://127.0.0.1:1234');
    const lease = control.connect('one', 'Hermes', ['workspace:read', 'workspace:read']);
    expect(lease.capabilities).toEqual(['workspace:read']);
    control.require('one', 'workspace:read');
    expect(control.renew('one').expiresAt).toBe(1_500);
  });

  it('rejects a second active client and permits it after revoke', () => {
    const control = new McpControl({ leaseMs: 10_000 });
    control.enable();
    control.connect('one', undefined, ['workspace:read']);
    expect(() => control.connect('two', undefined, ['workspace:read'])).toThrow(/Another/);
    control.revoke();
    expect(control.status().state).toBe('revoked');
    expect(control.connect('two', undefined, ['workspace:read']).clientId).toBe('two');
  });

  it('expires leases and blocks operations', () => {
    let now = 0;
    const control = new McpControl({ now: () => now, leaseMs: 100 });
    control.enable();
    control.connect('one', undefined, ['workspace:read']);
    now = 100;
    expect(() => control.require('one', 'workspace:read')).toThrow(/expired|active/);
    expect(control.status().state).toBe('revoked');
  });

  it('revokes without closing or changing the client-owned pane data', () => {
    const control = new McpControl();
    control.enable();
    control.connect('one', undefined, ['session:read']);
    control.revoke('takeover');
    expect(control.status().capabilities).toEqual([]);
    expect(() => control.require('one', 'session:read')).toThrow();
  });
});
