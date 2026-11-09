import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RecentSession, StoredRecentSessionFile } from '../shared/types.js';

const SCHEMA_VERSION = 1;
/** Enough to fill the launch picker with room to spare; older ones fall off. */
export const MAX_RECENT_SESSIONS = 12;

/**
 * Main-process-only, best-effort memory of the sessions open recently, for the
 * launch picker.
 *
 * Stores what is needed to open a shell like it again — kind, host, name,
 * backend — and, only when the user has turned on "Remember directories", the
 * directory it was last in. Never a command, an argument or a credential: this
 * is plain JSON in the user's profile, the same reason the other stores give.
 * The renderer decides what is recorded and strips `cwd` when the setting is
 * off; this file only guarantees that what comes back is well formed.
 */
export class RecentSessionStore {
  private readonly filePath: string;
  private file: StoredRecentSessionFile = { version: SCHEMA_VERSION, sessions: [] };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { filePath: string }) {
    this.filePath = options.filePath;
  }

  async load(): Promise<StoredRecentSessionFile> {
    await this.ensureLoaded();
    return normalizeFile(this.file) ?? { version: SCHEMA_VERSION, sessions: [] };
  }

  async save(input: unknown): Promise<StoredRecentSessionFile> {
    await this.ensureLoaded();
    // Validated on the way in as well as out: this is an IPC boundary, and a
    // stored bad value would come back on every launch from then on.
    const normalized = normalizeFile(input);
    if (!normalized) throw new Error('Invalid recent session list.');
    this.file = normalized;
    await this.persist();
    return normalized;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      const normalized = normalizeFile(parsed);
      if (normalized) this.file = normalized;
    } catch {
      this.file = { version: SCHEMA_VERSION, sessions: [] };
    }
  }

  private async persist(): Promise<void> {
    const snapshot = this.file;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temp = join(dirname(this.filePath), `.recent-sessions.tmp-${process.pid}-${randomUUID()}`);
        await writeFile(temp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.filePath);
      } catch {
        // Remembering recent sessions must never affect terminal operation.
      }
    });
    await this.writeQueue;
  }
}

/** Drop control characters and cap length; the file is user-editable. */
function safeText(value: string, limit: number): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    out += char;
  }
  return out.trim().slice(0, limit);
}

function optionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = safeText(value, limit);
  return text || undefined;
}

function normalizeEntry(value: unknown): RecentSession | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.kind !== 'local' && item.kind !== 'ssh') return undefined;
  const key = optionalText(item.key, 600);
  const name = optionalText(item.name, 64);
  const lastSeen = optionalText(item.lastSeen, 40);
  if (!key || !name || !lastSeen || Number.isNaN(Date.parse(lastSeen))) return undefined;
  const entry: RecentSession = { key, kind: item.kind, name, lastSeen };
  const host = optionalText(item.host, 256);
  const sshTarget = optionalText(item.sshTarget, 256);
  const screenName = optionalText(item.screenName, 64);
  const backend = optionalText(item.backend, 32);
  const wslDistribution = optionalText(item.wslDistribution, 64);
  const cwd = optionalText(item.cwd, 512);
  if (host) entry.host = host;
  if (sshTarget) entry.sshTarget = sshTarget;
  if (screenName) entry.screenName = screenName;
  if (backend) entry.backend = backend;
  if (wslDistribution) entry.wslDistribution = wslDistribution;
  if (cwd) entry.cwd = cwd;
  return entry;
}

export function normalizeFile(value: unknown): StoredRecentSessionFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== SCHEMA_VERSION) return undefined;
  if (!Array.isArray(item.sessions)) return undefined;

  // Newest first, each shell once: the first occurrence of a key wins, so a
  // hand-edited file that repeats one keeps its most recent position.
  const seen = new Set<string>();
  const sessions: RecentSession[] = [];
  for (const raw of item.sessions) {
    const entry = normalizeEntry(raw);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    sessions.push(entry);
  }
  sessions.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
  return { version: SCHEMA_VERSION, sessions: sessions.slice(0, MAX_RECENT_SESSIONS) };
}

export function defaultRecentSessionPath(userDataPath: string): string {
  return join(userDataPath, 'recent-sessions.json');
}
