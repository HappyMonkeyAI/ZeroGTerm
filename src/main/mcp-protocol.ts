import type { McpCapability, McpControlStatus, StoredWorkspaceFile } from '../shared/types.js';
export type { McpCapability, McpControlStatus } from '../shared/types.js';

export interface McpLease {
  clientId: string;
  clientName?: string;
  capabilities: McpCapability[];
  expiresAt: number;
}


export interface McpOperationResult {
  ok: boolean;
  message?: string;
  data?: unknown;
}

export interface McpRestoreResult {
  workspaceId: string;
  status: 'already-ready' | 'restored' | 'awaiting-user-consent' | 'partial' | 'failed';
  panes: Array<{
    sessionId: string;
    name: string;
    status: 'already-running' | 'reattached' | 'awaiting-user-consent' | 'skipped' | 'failed';
    message?: string;
  }>;
}

export function isMcpCapability(value: unknown): value is McpCapability {
  return value === 'workspace:read' || value === 'workspace:restore' || value === 'workspace:write' ||
    value === 'session:read' || value === 'session:create' || value === 'session:close' || value === 'session:execute';
}

export function requireMcpCapability(lease: McpLease | undefined, capability: McpCapability, now = Date.now()): void {
  if (!lease) throw new Error('No AI control lease is active.');
  if (lease.expiresAt <= now) throw new Error('The AI control lease has expired.');
  if (!lease.capabilities.includes(capability)) throw new Error(`The AI connection lacks ${capability} capability.`);
}

export function requireBoundedString(value: unknown, field: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required.`);
  const clean = value.trim();
  if (clean.length > max) throw new Error(`${field} is too long.`);
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new Error(`${field} contains control characters.`);
  return clean;
}

export function requireWorkspaceId(value: unknown): string {
  return requireBoundedString(value, 'workspaceId', 64);
}

export function requireSessionId(value: unknown): string {
  return requireBoundedString(value, 'sessionId', 128);
}

export function requireWorkspaceName(value: unknown): string {
  const name = requireBoundedString(value, 'name', 49);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_.]|-| ){0,48}$/.test(name)) {
    throw new Error('Workspace name contains unsupported characters.');
  }
  return name;
}

export function requireStoredWorkspaceFile(value: unknown): StoredWorkspaceFile {
  if (!value || typeof value !== 'object') throw new Error('A workspace file is required.');
  const file = value as Partial<StoredWorkspaceFile>;
  if (file.version !== 1 || !Array.isArray(file.workspaces)) throw new Error('Invalid workspace file.');
  return value as StoredWorkspaceFile;
}

export function boundedDeadline(value: unknown, defaultMs = 10_000, maxMs = 60_000): number {
  if (value === undefined) return defaultMs;
  if (!Number.isInteger(value) || (value as number) < 100 || (value as number) > maxMs) {
    throw new Error(`deadlineMs must be between 100 and ${maxMs}.`);
  }
  return value as number;
}
