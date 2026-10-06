import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StoredHostLabelFile } from '../shared/types.js';

const SCHEMA_VERSION = 1;
const MAX_HOSTS = 256;
// Session names cap at 48, so a longer remembered label could never be reused.
const MAX_LABEL = 48;

export type StoredHostLabel = StoredHostLabelFile['hosts'][number];

/**
 * Main-process-only, best-effort memory of the session label last given to each
 * host, so the SSH dialog can offer it again instead of the user retyping
 * "dev server" every time.
 *
 * Stores a host and a label — never a user name, a credential, or a command —
 * the same guarantee the other stores make, and for the same reason: this is
 * plain JSON in the user's profile. The renderer decides what a host is called
 * for this purpose; the file only guarantees what comes back is well formed.
 */
export class HostLabelStore {
  private readonly filePath: string;
  private file: StoredHostLabelFile = { version: SCHEMA_VERSION, hosts: [] };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { filePath: string }) {
    this.filePath = options.filePath;
  }

  async load(): Promise<StoredHostLabelFile> {
    await this.ensureLoaded();
    return normalizeFile(this.file) ?? { version: SCHEMA_VERSION, hosts: [] };
  }

  async save(input: unknown): Promise<StoredHostLabelFile> {
    await this.ensureLoaded();
    // Validated on the way in as well as out: this is an IPC boundary, and a
    // stored bad value would come back on every launch from then on.
    const normalized = normalizeFile(input);
    if (!normalized) throw new Error('Invalid host label list.');
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
      this.file = { version: SCHEMA_VERSION, hosts: [] };
    }
  }

  private async persist(): Promise<void> {
    const snapshot = this.file;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temp = join(dirname(this.filePath), `.host-labels.tmp-${process.pid}-${randomUUID()}`);
        await writeFile(temp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.filePath);
      } catch {
        // Remembering a label must never affect terminal operation.
      }
    });
    await this.writeQueue;
  }
}

/** Strip control characters and cap length; the file is user-editable. */
function safeText(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
}

function normalizeEntry(value: unknown): StoredHostLabel | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.host !== 'string' || typeof item.label !== 'string') return undefined;
  const host = safeText(item.host, 256).toLowerCase();
  const label = safeText(item.label, MAX_LABEL);
  if (!host || !label) return undefined;
  return { host, label };
}

export function normalizeFile(value: unknown): StoredHostLabelFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== SCHEMA_VERSION) return undefined;
  if (!Array.isArray(item.hosts)) return undefined;

  // Later entries win and an entry is only kept once, so a hand-edited file
  // that repeats a host settles on its last word rather than its first.
  const byHost = new Map<string, StoredHostLabel>();
  for (const raw of item.hosts) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    byHost.delete(entry.host);
    byHost.set(entry.host, entry);
  }
  // Oldest first, so the cap drops the host not touched for longest.
  return { version: SCHEMA_VERSION, hosts: [...byHost.values()].slice(-MAX_HOSTS) };
}

export function defaultHostLabelPath(userDataPath: string): string {
  return join(userDataPath, 'host-labels.json');
}
