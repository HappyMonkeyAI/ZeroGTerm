import { createHash } from 'node:crypto';

export type McpAuditState = 'requested' | 'approved' | 'rejected' | 'running' | 'completed' | 'timed-out' | 'cancelled' | 'failed';
export interface McpAuditEvent {
  at: number;
  requestId: string;
  client: string;
  capability: 'session:execute';
  sessionId: string;
  state: McpAuditState;
  command: string;
}

const MAX_EVENTS = 256;
const MAX_COMMAND = 256;

export class McpAudit {
  private readonly events: McpAuditEvent[] = [];
  record(input: Omit<McpAuditEvent, 'client' | 'command'> & { clientId: string; command: string }): void {
    this.events.push({ ...input, client: createHash('sha256').update(input.clientId).digest('hex').slice(0, 16), command: input.command.slice(0, MAX_COMMAND) });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }
  list(): McpAuditEvent[] { return this.events.map((event) => ({ ...event })); }
}
