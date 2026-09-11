import type { McpExecutionPolicy } from '../shared/types.js';

export const DEFAULT_MCP_EXECUTION_POLICY: McpExecutionPolicy = {
  allowShellOperators: false,
  allowRemoteSessions: false,
  maxCommandLength: 512,
  maxRuntimeMs: 30_000,
  maxOutputBytes: 16 * 1024
};

export interface CommandPolicyInput {
  command: unknown;
  sessionKind: 'local' | 'ssh';
  policy?: Partial<McpExecutionPolicy>;
}

export interface CommandPolicyDecision {
  allowed: boolean;
  reason?: string;
  command?: string;
  displayCommand?: string;
  policy: McpExecutionPolicy;
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SHELL_OPERATORS = /[|;&<>`$(){}\\]/;
const CREDENTIAL_SHAPE = /(?:bearer\s+|password\s*=|token\s*=|api[_-]?key\s*=|-----begin\s+[^\r\n]+-----)/i;

export function validateMcpCommand(input: CommandPolicyInput): CommandPolicyDecision {
  const policy = { ...DEFAULT_MCP_EXECUTION_POLICY, ...(input.policy ?? {}) };
  if (typeof input.command !== 'string') return denied(policy, 'Command must be text.');
  const command = input.command.trim();
  if (!command) return denied(policy, 'Command is required.');
  if (command.length > policy.maxCommandLength) return denied(policy, 'Command is too long.');
  if (/[\r\n]/.test(command)) return denied(policy, 'Only one command line may be requested.');
  if (CONTROL.test(command)) return denied(policy, 'Command contains control characters.');
  if (CREDENTIAL_SHAPE.test(command)) return denied(policy, 'Credential-like command content is disabled.');
  if (!policy.allowShellOperators && SHELL_OPERATORS.test(command)) return denied(policy, 'Shell operators are disabled.');
  if (input.sessionKind === 'ssh' && !policy.allowRemoteSessions) return denied(policy, 'Remote command execution is disabled.');
  return { allowed: true, command, displayCommand: redactCommand(command), policy };
}

function redactCommand(command: string): string {
  if (CREDENTIAL_SHAPE.test(command)) return '[redacted command: credential-like content]';
  return command;
}

function denied(policy: McpExecutionPolicy, reason: string): CommandPolicyDecision {
  return { allowed: false, reason, policy };
}
