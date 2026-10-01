// Loopback listener for the hooks of agents that ZeroG launched itself.
//
// Each launched agent gets its own settings file (passed with --settings, so no user or
// project settings are edited) pointing four hook events at a URL that carries a random
// per-agent token. The token is the only credential: the listener binds to 127.0.0.1
// only, and a request for an unknown token is a 404 that reveals nothing. The token also
// identifies the session, so a hook cannot claim to be a different pane.
//
// The hook response is an empty JSON object: ZeroG observes the agent, it never steers it
// (no blocking, no injected context).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentHookEvent, AgentHookEventName } from './pane-link.js';

export const HOOK_EVENTS: readonly AgentHookEventName[] = ['UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd'];
/** A Stop payload carries the whole final message, so allow generously but not without bound. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface AgentHookServerOptions {
  /** Where per-agent settings files are written. Created on demand. */
  settingsDir: string;
  onEvent: (event: AgentHookEvent) => void;
}

export interface RegisteredAgent {
  sessionId: string;
  settingsPath: string;
}

interface Registration {
  sessionId: string;
  settingsPath: string;
}

/** Settings JSON that points each observed hook event at `url`. Exported for tests. */
export function buildHookSettings(url: string): { hooks: Record<string, Array<{ hooks: Array<{ type: 'http'; url: string }> }>> } {
  const hooks: Record<string, Array<{ hooks: Array<{ type: 'http'; url: string }> }>> = {};
  for (const event of HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: 'http', url }] }];
  return { hooks };
}

/** Turn a raw hook payload into the small event the controller understands, or undefined to ignore it. */
export function parseHookPayload(sessionId: string, payload: unknown): AgentHookEvent | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const name = record.hook_event_name;
  if (typeof name !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(name)) return undefined;
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : undefined);
  return {
    sessionId,
    event: name as AgentHookEventName,
    message: text('last_assistant_message'),
    notificationType: text('notification_type'),
    reason: text('reason')
  };
}

export class AgentHookServer {
  private readonly options: AgentHookServerOptions;
  private readonly byToken = new Map<string, Registration>();
  private readonly bySession = new Map<string, string>();
  private http: Server | undefined;
  private port = 0;

  constructor(options: AgentHookServerOptions) {
    this.options = options;
  }

  /** Start listening on an ephemeral loopback port. Safe to call twice. */
  async start(): Promise<void> {
    if (this.http) return;
    const server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.http = server;
  }

  async stop(): Promise<void> {
    const server = this.http;
    this.http = undefined;
    const sessions = Array.from(this.bySession.keys());
    await Promise.all(sessions.map((sessionId) => this.unregister(sessionId)));
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /** Issue a token and a settings file for one launched agent. Replaces any earlier registration for the session. */
  async register(sessionId: string): Promise<RegisteredAgent> {
    if (!this.http) await this.start();
    await this.unregister(sessionId);
    const token = randomBytes(24).toString('hex');
    const settingsPath = join(this.options.settingsDir, `agent-${token.slice(0, 12)}.json`);
    const url = `http://127.0.0.1:${this.port}/hook/${token}`;
    await mkdir(this.options.settingsDir, { recursive: true });
    // The file holds the token, so keep it to the owner where the platform supports modes.
    await writeFile(settingsPath, JSON.stringify(buildHookSettings(url)), { mode: 0o600 });
    this.byToken.set(token, { sessionId, settingsPath });
    this.bySession.set(sessionId, token);
    return { sessionId, settingsPath };
  }

  async unregister(sessionId: string): Promise<void> {
    const token = this.bySession.get(sessionId);
    if (!token) return;
    this.bySession.delete(sessionId);
    const registration = this.byToken.get(token);
    this.byToken.delete(token);
    if (registration) await rm(registration.settingsPath, { force: true });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number, body = '{}') => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
    };
    const match = /^\/hook\/([0-9a-f]{48})$/.exec((req.url ?? '').split('?')[0]);
    const registration = match ? this.byToken.get(match[1]) : undefined;
    if (!registration) return reply(404, '{"error":"not found"}');
    if (req.method !== 'POST') return reply(405, '{"error":"method not allowed"}');

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reply(413, '{"error":"payload too large"}');
      try {
        const event = parseHookPayload(registration.sessionId, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (event) this.options.onEvent(event);
      } catch {
        return reply(400, '{"error":"bad request"}');
      }
      reply(200);
    });
    req.on('error', () => reply(400, '{"error":"bad request"}'));
  }
}

/**
 * The command typed into the pane: the user's agent command plus the settings file.
 *
 * Forward slashes keep the path safe inside double quotes in PowerShell, cmd and bash alike.
 * The command comes from a user setting, so it must be a single plain line.
 */
export function buildLaunchCommand(agentCommand: string, settingsPath: string): string {
  const command = agentCommand.trim();
  if (!command || command.length > 200) throw new Error('The AI command must be 1 to 200 characters.');
  for (const ch of command) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) throw new Error('The AI command must be a single line with no control characters.');
  }
  const path = settingsPath.replace(/\\/g, '/');
  if (path.includes('"')) throw new Error('The settings path cannot contain a quote.');
  return `${command} --settings "${path}"`;
}
