import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PortForwardInfo, StoredPortForwardFile } from '../shared/types.js';

const SCHEMA_VERSION = 1;
const MAX_FORWARDS = 64;

export type StoredForward = StoredPortForwardFile['forwards'][number];

/**
 * Main-process-only, best-effort memory of which ports were shared.
 *
 * Stores where a tunnel went and how wide it was bound — never a credential, a
 * cwd, or command arguments — the same guarantee SessionHistoryStore and
 * WorkspaceStore make, and for the same reason: this is plain JSON in the user's
 * profile.
 *
 * Nothing here reopens a tunnel. Restored forwards come back as rows waiting to
 * be clicked, so launching the app never dials out to a host on its own.
 */
export class PortForwardStore {
  private readonly filePath: string;
  private file: StoredPortForwardFile = { version: SCHEMA_VERSION, forwards: [] };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { filePath: string }) {
    this.filePath = options.filePath;
  }

  async load(): Promise<StoredPortForwardFile> {
    await this.ensureLoaded();
    return normalizeFile(this.file) ?? { version: SCHEMA_VERSION, forwards: [] };
  }

  async save(input: unknown): Promise<StoredPortForwardFile> {
    await this.ensureLoaded();
    // Validated on the way in as well as out: the renderer is the only caller,
    // but this is an IPC boundary, and a stored bad value would come back on
    // every launch from then on.
    const normalized = normalizeFile(input);
    if (!normalized) throw new Error('Invalid shared port list.');
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
      this.file = { version: SCHEMA_VERSION, forwards: [] };
    }
  }

  private async persist(): Promise<void> {
    const snapshot = this.file;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temp = join(dirname(this.filePath), `.port-forwards.tmp-${process.pid}-${randomUUID()}`);
        await writeFile(temp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.filePath);
      } catch {
        // Remembering a port must never affect terminal operation.
      }
    });
    await this.writeQueue;
  }
}

/** Strip control characters and cap length; the file is user-editable. */
function safeText(value: string, limit = 256): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit);
}

function port(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) return undefined;
  return value;
}

function normalizeForward(value: unknown): StoredForward | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.target !== 'string') return undefined;
  if (item.direction !== 'local' && item.direction !== 'remote') return undefined;
  // A missing or unrecognised bind reads as loopback, never as the wide one: a
  // hand-edited or truncated file must not be able to widen a forward silently.
  const bind = item.bind === 'all' ? 'all' : 'loopback';
  const listenPort = port(item.listenPort);
  const destinationPort = port(item.destinationPort);
  const id = safeText(item.id, 64);
  const target = safeText(item.target, 256);
  if (!id || !target || listenPort === undefined || destinationPort === undefined) return undefined;

  const forward: StoredForward = { id, target, direction: item.direction, listenPort, destinationPort, bind };
  // Left off entirely when absent, so the protocol's own default applies rather
  // than an empty string reaching the forward spec.
  const destinationHost = typeof item.destinationHost === 'string' ? safeText(item.destinationHost, 253) : '';
  if (destinationHost) forward.destinationHost = destinationHost;
  return forward;
}

export function normalizeFile(value: unknown): StoredPortForwardFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== SCHEMA_VERSION) return undefined;
  if (!Array.isArray(item.forwards)) return undefined;

  const forwards: StoredForward[] = [];
  const seen = new Set<string>();
  for (const raw of item.forwards) {
    const forward = normalizeForward(raw);
    if (!forward || seen.has(forward.id)) continue;
    seen.add(forward.id);
    forwards.push(forward);
    if (forwards.length >= MAX_FORWARDS) break;
  }
  return { version: SCHEMA_VERSION, forwards };
}

/** What is worth remembering about a live tunnel: everything but how it is doing. */
export function forgetStatus(forward: PortForwardInfo): StoredForward {
  const { status, message, ...rest } = forward;
  return rest;
}

export function defaultPortForwardPath(userDataPath: string): string {
  return join(userDataPath, 'port-forwards.json');
}
