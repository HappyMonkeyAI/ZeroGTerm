import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * A small JSON file in the user's profile, read once and written atomically.
 *
 * The shape of every best-effort store here: validate on the way in as well as
 * out (the renderer is the only caller, but this is an IPC boundary and a bad
 * value would come back on every launch), write through a temp file and a
 * rename so a crash cannot leave half a file, and never let a failed write
 * reach the terminals.
 */
export class JsonFileStore<T> {
  private readonly filePath: string;
  private readonly normalize: (value: unknown) => T | undefined;
  private readonly empty: () => T;
  private readonly invalidMessage: string;
  private file: T;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    filePath: string;
    normalize: (value: unknown) => T | undefined;
    empty: () => T;
    invalidMessage: string;
  }) {
    this.filePath = options.filePath;
    this.normalize = options.normalize;
    this.empty = options.empty;
    this.invalidMessage = options.invalidMessage;
    this.file = options.empty();
  }

  async load(): Promise<T> {
    await this.ensureLoaded();
    return this.normalize(this.file) ?? this.empty();
  }

  async save(input: unknown): Promise<T> {
    await this.ensureLoaded();
    const normalized = this.normalize(input);
    if (!normalized) throw new Error(this.invalidMessage);
    this.file = normalized;
    await this.persist();
    return normalized;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      const normalized = this.normalize(parsed);
      if (normalized) this.file = normalized;
    } catch {
      this.file = this.empty();
    }
  }

  private async persist(): Promise<void> {
    const snapshot = this.file;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temp = join(dirname(this.filePath), `.store.tmp-${process.pid}-${randomUUID()}`);
        await writeFile(temp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.filePath);
      } catch {
        // Remembering preferences must never affect terminal operation.
      }
    });
    await this.writeQueue;
  }
}

/** Drop control characters, trim and cap length; these files are user-editable. */
export function safeText(value: string, limit: number): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    out += char;
  }
  return out.trim().slice(0, limit);
}

/** A string field, cleaned, or undefined when absent or empty. */
export function optionalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = safeText(value, limit);
  return text || undefined;
}
