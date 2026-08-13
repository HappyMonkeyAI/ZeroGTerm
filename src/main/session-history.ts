import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HistoryEntry, SessionInfo } from '../shared/types.js';

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 100;

type HistoryFile = { version: number; entries: HistoryEntry[] };

export type HistoryStoreOptions = {
  filePath: string;
  limit?: number;
  now?: () => Date;
};

/** Main-process-only, best-effort history persistence. Never stores cwd, args, or credentials. */
export class SessionHistoryStore {
  private readonly filePath: string;
  private readonly limit: number;
  private readonly now: () => Date;
  private entries: HistoryEntry[] = [];
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: HistoryStoreOptions) {
    this.filePath = options.filePath;
    this.limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
    this.now = options.now ?? (() => new Date());
  }

  async list(): Promise<HistoryEntry[]> {
    await this.ensureLoaded();
    return this.entries.map((entry) => ({ ...entry, session: { ...entry.session } }));
  }

  async record(event: HistoryEntry['event'], session: SessionInfo, available: boolean): Promise<HistoryEntry> {
    await this.ensureLoaded();
    const entry: HistoryEntry = {
      id: randomUUID(),
      timestamp: this.now().toISOString(),
      event,
      session: redactSession(session),
      available: Boolean(available)
    };
    this.entries = [entry, ...this.entries].slice(0, this.limit);
    await this.persist();
    return entry;
  }

  async remove(entryId: string): Promise<boolean> {
    await this.ensureLoaded();
    const index = this.entries.findIndex((item) => item.id === entryId);
    if (index < 0) return false;
    this.entries = this.entries.filter((item) => item.id !== entryId);
    await this.persist();
    return true;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (!isHistoryFile(parsed)) return;
      this.entries = parsed.entries.slice(0, this.limit).map(normalizeEntry).filter((entry): entry is HistoryEntry => entry !== undefined);
    } catch {
      this.entries = [];
    }
  }

  private async persist(): Promise<void> {
    const snapshot: HistoryFile = { version: SCHEMA_VERSION, entries: this.entries };
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temp = join(dirname(this.filePath), `.history.tmp-${process.pid}-${randomUUID()}`);
        await writeFile(temp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.filePath);
      } catch {
        // History must never affect terminal operation.
      }
    });
    await this.writeQueue;
  }
}

function redactSession(session: SessionInfo): HistoryEntry['session'] {
  const result: HistoryEntry['session'] = {
    id: safeText(session.id), name: safeText(session.name), kind: session.kind, host: safeText(session.host), backend: session.backend, scope: session.scope, screenName: session.screenName, sshTarget: session.sshTarget, wslDistribution: session.wslDistribution
  };
  if (typeof session.backend === 'string') result.backend = safeText(session.backend) as HistoryEntry['session']['backend'];
  if (typeof session.scope === 'string') result.scope = safeText(session.scope) as HistoryEntry['session']['scope'];
  if (typeof session.screenName === 'string') result.screenName = safeText(session.screenName);
  if (typeof session.sshTarget === 'string') result.sshTarget = safeText(session.sshTarget);
  if (typeof session.wslDistribution === 'string') result.wslDistribution = safeText(session.wslDistribution);
  return result;
}

function safeText(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256); }
function isHistoryFile(value: unknown): value is HistoryFile {
  return typeof value === 'object' && value !== null && (value as any).version === SCHEMA_VERSION && Array.isArray((value as any).entries);
}
function normalizeEntry(value: unknown): HistoryEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as any;
  if (typeof item.id !== 'string' || typeof item.timestamp !== 'string' || !['created', 'attached', 'detached', 'closed', 'reconnect-failed'].includes(item.event) || typeof item.available !== 'boolean' || !item.session || typeof item.session !== 'object') return undefined;
  if (!['local', 'ssh'].includes(item.session.kind) || typeof item.session.id !== 'string' || typeof item.session.name !== 'string' || typeof item.session.host !== 'string') return undefined;
  return { id: safeText(item.id), timestamp: item.timestamp, event: item.event, available: item.available, session: redactSession(item.session as SessionInfo) };
}

export function defaultHistoryPath(userDataPath: string): string { return join(userDataPath, 'session-history.json'); }
