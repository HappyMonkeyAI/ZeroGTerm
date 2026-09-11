import { randomUUID } from 'node:crypto';
import type { McpExecutionPolicy, McpExecutionRequest, McpExecutionResult } from '../shared/types.js';
import { validateMcpCommand } from './mcp-execution-policy.js';

export interface CreateExecutionInput {
  clientId: string;
  sessionId: string;
  sessionKind: 'local' | 'ssh';
  command: unknown;
  now?: number;
  approvalTtlMs?: number;
  policy?: Partial<McpExecutionPolicy>;
}

interface Pending {
  request: McpExecutionRequest;
  result?: McpExecutionResult;
}

/** Approval state only. Execution remains owned by the main-process PTY layer. */
export class McpExecutionBroker {
  private readonly maxPending: number;
  private readonly pending = new Map<string, Pending>();

  constructor(options: { maxPending?: number } = {}) {
    this.maxPending = options.maxPending ?? 8;
  }

  create(input: CreateExecutionInput): McpExecutionRequest {
    const decision = validateMcpCommand(input);
    if (!decision.allowed || !decision.command || !decision.displayCommand) throw new Error(decision.reason ?? 'Command rejected.');
    if (Array.from(this.pending.values()).some((item) => item.request.clientId === input.clientId && item.request.sessionId === input.sessionId && item.request.state === 'pending')) {
      throw new Error('A command approval is already pending for this session.');
    }
    if (Array.from(this.pending.values()).filter((item) => item.request.state === 'pending').length >= this.maxPending) throw new Error('Too many pending command approvals.');
    const now = input.now ?? Date.now();
    const request: McpExecutionRequest = {
      requestId: randomUUID(), clientId: input.clientId, sessionId: input.sessionId,
      command: decision.command, displayCommand: decision.displayCommand, state: 'pending',
      createdAt: now, expiresAt: now + Math.min(input.approvalTtlMs ?? 60_000, 5 * 60_000), policy: decision.policy
    };
    this.pending.set(request.requestId, { request });
    return { ...request, policy: { ...request.policy } };
  }

  get(requestId: string, clientId: string, now = Date.now()): McpExecutionRequest | McpExecutionResult {
    const item = this.owned(requestId, clientId);
    this.expire(item, now);
    return item.result ? { ...item.result } : { ...item.request, policy: { ...item.request.policy } };
  }

  decide(requestId: string, clientId: string, decision: 'approve' | 'reject', now = Date.now()): McpExecutionRequest {
    const item = this.owned(requestId, clientId);
    this.expire(item, now);
    if (item.request.state !== 'pending') throw new Error('Command approval is no longer pending.');
    item.request.state = decision === 'approve' ? 'approved' : 'rejected';
    if (decision === 'reject') this.finish(item, 'rejected', 'Rejected by the user.', now);
    return { ...item.request, policy: { ...item.request.policy } };
  }

  decideFromUser(requestId: string, decision: 'approve' | 'reject', now = Date.now()): McpExecutionRequest {
    const item = this.pending.get(requestId);
    if (!item) throw new Error('Unknown command request.');
    this.expire(item, now);
    if (item.request.state !== 'pending') throw new Error('Command approval is no longer pending.');
    item.request.state = decision === 'approve' ? 'approved' : 'rejected';
    if (decision === 'reject') this.finish(item, 'rejected', 'Rejected by the user.', now);
    return { ...item.request, policy: { ...item.request.policy } };
  }

  start(requestId: string, now = Date.now()): McpExecutionRequest {
    const item = this.pending.get(requestId);
    if (!item) throw new Error('Unknown command request.');
    this.expire(item, now);
    if (item.request.state !== 'approved') throw new Error('Command must be approved before execution.');
    item.request.state = 'running';
    return { ...item.request, policy: { ...item.request.policy } };
  }

  finishRunning(requestId: string, state: 'completed' | 'timed-out' | 'failed', output: string, truncated: boolean, message: string, now = Date.now()): McpExecutionResult {
    const item = this.pending.get(requestId);
    if (!item) throw new Error('Unknown command request.');
    if (item.request.state !== 'running') throw new Error('Command is not running.');
    this.finish(item, state, message, now, output, truncated);
    return item.result!;
  }

  cancel(requestId: string, clientId: string, message = 'Cancelled by the user.', now = Date.now()): McpExecutionResult {
    const item = this.owned(requestId, clientId);
    this.finish(item, 'cancelled', message, now);
    return item.result!;
  }

  cancelFromUser(requestId: string, message = 'Cancelled by the user.', now = Date.now()): McpExecutionResult {
    const item = this.pending.get(requestId);
    if (!item) throw new Error('Unknown command request.');
    this.finish(item, 'cancelled', message, now);
    return item.result!;
  }

  revoke(clientId: string, now = Date.now()): void {
    for (const item of Array.from(this.pending.values())) if (item.request.clientId === clientId && !item.result) this.finish(item, 'cancelled', 'AI control was revoked.', now);
  }

  revokeAll(now = Date.now()): void {
    for (const item of Array.from(this.pending.values())) if (!item.result) this.finish(item, 'cancelled', 'AI control was revoked.', now);
  }

  list(clientId: string, now = Date.now()): Array<McpExecutionRequest | McpExecutionResult> {
    return Array.from(this.pending.values()).filter((item) => item.request.clientId === clientId).map((item) => this.get(item.request.requestId, clientId, now));
  }

  listAll(now = Date.now()): Array<McpExecutionRequest | McpExecutionResult> {
    return Array.from(this.pending.values()).map((item) => { this.expire(item, now); return item.result ? { ...item.result } : { ...item.request, policy: { ...item.request.policy } }; });
  }

  private owned(requestId: string, clientId: string): Pending {
    const item = this.pending.get(requestId);
    if (!item || item.request.clientId !== clientId) throw new Error('Unknown command request.');
    return item;
  }

  private expire(item: Pending, now: number): void {
    if (!item.result && item.request.state === 'pending' && item.request.expiresAt <= now) this.finish(item, 'timed-out', 'Approval expired.', now);
  }

  private finish(item: Pending, state: McpExecutionResult['state'], message: string, now: number, output?: string, truncated = false): void {
    item.request.state = state;
    item.result = { requestId: item.request.requestId, state, ...(output ? { output } : {}), ...(truncated ? { truncated: true } : {}), message, completedAt: now };
  }
}
