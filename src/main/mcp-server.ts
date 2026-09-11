import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpControl } from './mcp-control.js';
import type { McpCapability, McpControlStatus } from '../shared/types.js';
import { requireWorkspaceId } from './mcp-protocol.js';

export interface McpServerProviders {
  listWorkspaces: () => Promise<unknown>;
  listSessions: () => Promise<unknown>;
  createWorkspace?: (name: string) => Promise<unknown>;
  selectWorkspace?: (workspaceId: string) => Promise<unknown>;
  restoreWorkspace?: (workspaceId: string) => Promise<unknown>;
  createLocalSession?: (request: { name: string; cwd?: string; backend?: string }) => Promise<unknown>;
  closeSession?: (sessionId: string) => Promise<unknown>;
}

export interface McpServerHostOptions {
  providers: McpServerProviders;
  control?: McpControl;
  version?: string;
  port?: number;
  token?: string;
}

export interface McpServerInfo {
  endpoint: string;
  token: string;
}

const MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_CAPABILITIES: McpCapability[] = ['workspace:read', 'session:read'];

/** Local authenticated MCP endpoint owned by the running ZeroG instance. */
export class McpServerHost {
  private readonly providers: McpServerProviders;
  private readonly control: McpControl;
  private readonly version: string;
  private readonly configuredPort: number;
  private readonly token: string;
  private http: Server | undefined;
  private mcp: McpServer | undefined;
  private transport: StreamableHTTPServerTransport | undefined;

  constructor(options: McpServerHostOptions) {
    this.providers = options.providers;
    this.control = options.control ?? new McpControl();
    this.version = options.version ?? '0.0.0';
    this.configuredPort = options.port ?? 0;
    this.token = options.token ?? randomBytes(32).toString('base64url');
  }

  status(): McpControlStatus {
    return this.control.status();
  }

  async start(): Promise<McpServerInfo> {
    if (this.http) return { endpoint: this.endpoint(), token: this.token };
    this.mcp = this.buildMcpServer();
    this.transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await this.mcp.connect(this.transport);
    this.http = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(this.configuredPort, '127.0.0.1', () => {
        this.http!.off('error', reject);
        resolve();
      });
    });
    const address = this.http.address();
    const port = typeof address === 'object' && address ? address.port : this.configuredPort;
    this.control.enable(`http://127.0.0.1:${port}/mcp`);
    return { endpoint: this.endpoint(), token: this.token };
  }

  async stop(): Promise<void> {
    this.control.disable();
    await this.transport?.close().catch(() => undefined);
    this.transport = undefined;
    this.mcp = undefined;
    if (this.http) {
      await new Promise<void>((resolve) => this.http!.close(() => resolve()));
      this.http = undefined;
    }
  }

  private endpoint(): string {
    const address = this.http?.address();
    const port = typeof address === 'object' && address ? address.port : this.configuredPort;
    return `http://127.0.0.1:${port}/mcp`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== '/mcp') return respond(res, 404, { error: 'Not found' });
    if (!this.authorized(req)) return respond(res, 401, { error: 'Authorization required' }, { 'WWW-Authenticate': 'Bearer' });
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      return respond(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, POST, DELETE' });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      if (body.error) return respond(res, body.status, { error: body.error });
      await this.transport!.handleRequest(req, res, body.value);
      return;
    }
    await this.transport!.handleRequest(req, res);
  }

  private authorized(req: IncomingMessage): boolean {
    const value = req.headers.authorization;
    if (!value?.startsWith('Bearer ')) return false;
    const received = Buffer.from(value.slice(7));
    const expected = Buffer.from(this.token);
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  private buildMcpServer(): McpServer {
    const server = new McpServer({ name: 'zerogterm', version: this.version });
    server.registerTool('zerog_get_connection_status', {
      description: 'Return ZeroG MCP connection and AI lease state.',
      inputSchema: z.object({})
    }, async () => text(this.control.status()));
    server.registerTool('zerog_list_workspaces', {
      description: 'List saved ZeroG workspaces and pane metadata.',
      inputSchema: z.object({ clientId: z.string().min(1) })
    }, async ({ clientId }) => {
      this.control.require(clientId, 'workspace:read');
      return text(await this.providers.listWorkspaces());
    });
    server.registerTool('zerog_list_sessions', {
      description: 'List ZeroG terminal sessions without terminal output or credentials.',
      inputSchema: z.object({ clientId: z.string().min(1) })
    }, async ({ clientId }) => {
      this.control.require(clientId, 'session:read');
      return text(await this.providers.listSessions());
    });
    server.registerTool('zerog_restore_workspace', {
      description: 'Restore a saved workspace and recreate only missing sessions. SSH authentication remains user-controlled.',
      inputSchema: z.object({ clientId: z.string().min(1), workspaceId: z.string().min(1).max(64) })
    }, async ({ clientId, workspaceId }) => {
      this.control.require(clientId, 'workspace:restore');
      if (!this.providers.restoreWorkspace) throw new Error('Workspace restoration is not available.');
      return text(await this.providers.restoreWorkspace(requireWorkspaceId(workspaceId)));
    });
    server.registerTool('zerog_acquire_control', {
      description: 'Acquire the single AI control lease for this local ZeroG instance.',
      inputSchema: z.object({ clientId: z.string().min(1).max(128), clientName: z.string().max(128).optional(), capabilities: z.array(z.enum(DEFAULT_CAPABILITIES as [string, ...string[]])).optional() })
    }, async ({ clientId, clientName, capabilities }) => text(this.control.connect(clientId, clientName, (capabilities ?? DEFAULT_CAPABILITIES) as McpCapability[])));
    server.registerTool('zerog_renew_control', {
      description: 'Renew the current AI control lease.',
      inputSchema: z.object({ clientId: z.string().min(1) })
    }, async ({ clientId }) => text(this.control.renew(clientId)));
    return server;
  }
}

function text(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function respond(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<{ value?: unknown; error?: string; status: number }> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY_BYTES) return { error: 'Request body is too large.', status: 413 };
    chunks.push(data);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')), status: 200 };
  } catch {
    return { error: 'Request body must be valid JSON.', status: 400 };
  }
}
