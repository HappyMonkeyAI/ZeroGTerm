import type { McpCapability, McpControlStatus, McpLease } from './mcp-protocol.js';
import { requireMcpCapability } from './mcp-protocol.js';

export interface McpControlOptions {
  leaseMs?: number;
  now?: () => number;
  onChange?: (status: McpControlStatus) => void;
}

/**
 * The single-client control lease. This class deliberately knows nothing about
 * MCP or Electron so revocation and expiry can be tested without a running app.
 */
export class McpControl {
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly onChange?: (status: McpControlStatus) => void;
  private lease: McpLease | undefined;
  private state: McpControlStatus = { state: 'disabled', capabilities: [] };

  constructor(options: McpControlOptions = {}) {
    this.leaseMs = options.leaseMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
  }

  status(): McpControlStatus {
    this.expireIfNeeded();
    return { ...this.state, capabilities: [...this.state.capabilities] };
  }

  enable(endpoint?: string): McpControlStatus {
    this.state = { state: 'listening', endpoint, capabilities: [] };
    this.emit();
    return this.status();
  }

  disable(): void {
    this.lease = undefined;
    this.state = { state: 'disabled', capabilities: [] };
    this.emit();
  }

  connect(clientId: string, clientName: string | undefined, capabilities: McpCapability[]): McpLease {
    if (this.state.state === 'disabled') throw new Error('MCP control is disabled in ZeroG settings.');
    if (this.lease && this.lease.clientId !== clientId && this.isLeaseActive()) {
      throw new Error('Another AI client already holds the ZeroG control lease.');
    }
    const unique = Array.from(new Set(capabilities));
    this.lease = { clientId, ...(clientName ? { clientName } : {}), capabilities: unique, expiresAt: this.now() + this.leaseMs };
    this.state = { ...this.state, state: 'connected', clientName, leaseExpiresAt: this.lease.expiresAt, capabilities: unique };
    this.emit();
    return { ...this.lease, capabilities: [...this.lease.capabilities] };
  }

  renew(clientId: string): McpLease {
    this.requireClient(clientId);
    const lease = this.lease!;
    lease.expiresAt = this.now() + this.leaseMs;
    this.state = { ...this.state, leaseExpiresAt: lease.expiresAt };
    this.emit();
    return { ...lease, capabilities: [...lease.capabilities] };
  }

  upgrade(clientId: string, capabilities: McpCapability[]): McpLease {
    this.requireClient(clientId);
    const lease = this.lease!;
    const unique = Array.from(new Set([...lease.capabilities, ...capabilities]));
    lease.capabilities = unique;
    lease.expiresAt = this.now() + this.leaseMs;
    this.state = { ...this.state, leaseExpiresAt: lease.expiresAt, capabilities: unique };
    this.emit();
    return { ...lease, capabilities: [...lease.capabilities] };
  }

  revoke(reason = 'AI control revoked by the user.'): void {
    this.lease = undefined;
    this.state = { ...this.state, state: 'revoked', leaseExpiresAt: undefined, capabilities: [] };
    this.emit();
    void reason;
  }

  require(clientId: string, capability: McpCapability): void {
    this.expireIfNeeded();
    const lease = this.lease;
    if (!lease || lease.clientId !== clientId) throw new Error('This AI client does not hold the active control lease.');
    requireMcpCapability(lease, capability, this.now());
  }

  private requireClient(clientId: string): void {
    this.expireIfNeeded();
    if (!this.lease || this.lease.clientId !== clientId) throw new Error('This AI client does not hold the active control lease.');
  }

  private isLeaseActive(): boolean {
    return Boolean(this.lease && this.lease.expiresAt > this.now());
  }

  private expireIfNeeded(): void {
    if (this.lease && this.lease.expiresAt <= this.now()) {
      this.lease = undefined;
      this.state = { ...this.state, state: 'revoked', leaseExpiresAt: undefined, capabilities: [] };
      this.emit();
    }
  }

  private emit(): void {
    this.onChange?.(this.statusWithoutExpiry());
  }

  private statusWithoutExpiry(): McpControlStatus {
    return { ...this.state, capabilities: [...this.state.capabilities] };
  }
}
