import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommandHistoryEntry, CommandRecord, StoredCommandHistoryFile } from '../shared/types.js';

const SCHEMA_VERSION = 1;

/**
 * How many commands to keep.
 *
 * Large enough that a month of work fits, small enough that the whole file is
 * read, ranked and written in memory without anyone noticing. JSON per
 * CONTEXT.md's answered question 7; SQLite remains the option that doc says it
 * is, if this ceiling ever becomes the thing that hurts.
 */
const MAX_ENTRIES = 5000;

const MAX_COMMAND_CHARS = 1000;

/**
 * The command history on disk.
 *
 * The only ZeroG store that holds what the user typed, which is why it is off
 * until asked for and why nothing reaches it that has not been through
 * command-redaction. That check runs in the renderer, next to the capture; this
 * side enforces the shape and the ceiling.
 */
export class CommandHistoryStore {
  private readonly filePath: string;
  private file: StoredCommandHistoryFile = { version: SCHEMA_VERSION, entries: [] };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { filePath: string; now?: () => Date }) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  async list(): Promise<CommandHistoryEntry[]> {
    await this.ensureLoaded();
    return this.file.entries.map((entry) => ({ ...entry }));
  }

  /**
   * Record a run, or note another one of something already known.
   *
   * Upserted on command *and* directory, so `runs` counts what it says it does
   * and the directory a command belongs to is not overwritten by the next place
   * it happens to be typed.
   */
  async record(input: CommandRecord): Promise<CommandHistoryEntry | null> {
    await this.ensureLoaded();
    const command = safeText(input.command, MAX_COMMAND_CHARS);
    if (!command) return null;

    const cwd = optionalText(input.cwd, 1024);
    const existing = this.file.entries.find((entry) => entry.command === command && entry.cwd === cwd);
    const lastRun = this.now().toISOString();

    if (existing) {
      existing.runs += 1;
      existing.lastRun = lastRun;
      // The latest outcome replaces the last, including replacing a known status
      // with none: a command that used to work and now reports nothing should
      // not keep claiming success.
      if (input.exitCode === undefined) delete existing.exitCode;
      else existing.exitCode = input.exitCode;
      await this.persist();
      return { ...existing };
    }

    const entry: CommandHistoryEntry = {
      id: `cmd:${randomUUID()}`,
      command,
      ...(cwd ? { cwd } : {}),
      ...(optionalText(input.host, 256) ? { host: String(input.host) } : {}),
      ...(input.kind === 'ssh' || input.kind === 'local' ? { kind: input.kind } : {}),
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      lastRun,
      runs: 1,
      picks: 0
    };
    this.file.entries.push(entry);
    this.evict();
    await this.persist();
    return { ...entry };
  }

  /**
   * Note that an entry was chosen from the palette.
   *
   * McFly's most useful signal, and the reason the ranking improves with use:
   * being picked says more about what someone wants than being run does, because
   * running happens by habit and picking happens on purpose.
   */
  async pick(id: string): Promise<void> {
    await this.ensureLoaded();
    const entry = this.file.entries.find((candidate) => candidate.id === id);
    if (!entry) return;
    entry.picks += 1;
    entry.lastRun = this.now().toISOString();
    await this.persist();
  }

  /** Forget everything, and take the file with it. */
  async clear(): Promise<void> {
    this.loaded = true;
    this.file = { version: SCHEMA_VERSION, entries: [] };
    // Emptied *and* removed: a file left holding `{"entries":[]}` looks like a
    // feature still running, and "clear my history" should leave nothing behind.
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await unlink(this.filePath);
      } catch {
        /* never existed */
      }
    });
    await this.writeQueue;
  }

  /**
   * Drop the least valuable entries once over the ceiling.
   *
   * Least recently run goes first, but anything ever picked from the palette is
   * kept ahead of anything never picked: a command someone deliberately chose
   * three weeks ago is worth more than one that scrolled past yesterday.
   */
  private evict(): void {
    if (this.file.entries.length <= MAX_ENTRIES) return;
    const ranked = [...this.file.entries].sort((a, b) => {
      if ((a.picks > 0) !== (b.picks > 0)) return a.picks > 0 ? -1 : 1;
      return b.lastRun.localeCompare(a.lastRun);
    });
    this.file.entries = ranked.slice(0, MAX_ENTRIES);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      const normalized = normalizeFile(parsed);
      if (normalized) this.file = normalized;
    } catch {
      this.file = { version: SCHEMA_VERSION, entries: [] };
    }
  }

  private async persist(): Promise<void> {
    const snapshot = this.file;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temp = join(dirname(this.filePath), `.command-history.tmp-${process.pid}-${randomUUID()}`);
        await writeFile(temp, JSON.stringify(snapshot, null, 1), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.filePath);
      } catch {
        // History must never affect terminal operation.
      }
    });
    await this.writeQueue;
  }
}

/** Strip control characters and cap length; the file is user-editable. */
function safeText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARACTERS, '').trim().slice(0, limit);
}

function optionalText(value: unknown, limit: number): string | undefined {
  const text = safeText(value, limit);
  return text ? text : undefined;
}

// Built from character codes rather than a regex literal: a control character
// inside a literal is invisible in the source and easily destroyed by a later
// edit. remote-screens.ts does the same, for the same reason.
const CONTROL_CHARACTERS = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']',
  'g'
);

function normalizeEntry(value: unknown): CommandHistoryEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const id = safeText(item.id, 64);
  const command = safeText(item.command, MAX_COMMAND_CHARS);
  const lastRun = safeText(item.lastRun, 40);
  if (!id || !command || !Number.isFinite(Date.parse(lastRun))) return undefined;

  const entry: CommandHistoryEntry = {
    id,
    command,
    lastRun: new Date(Date.parse(lastRun)).toISOString(),
    runs: count(item.runs, 1),
    picks: count(item.picks, 0)
  };
  const cwd = optionalText(item.cwd, 1024);
  const host = optionalText(item.host, 256);
  if (cwd) entry.cwd = cwd;
  if (host) entry.host = host;
  if (item.kind === 'ssh' || item.kind === 'local') entry.kind = item.kind;
  if (typeof item.exitCode === 'number' && Number.isInteger(item.exitCode) && item.exitCode >= 0 && item.exitCode <= 255) {
    entry.exitCode = item.exitCode;
  }
  return entry;
}

function count(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}

export function normalizeFile(value: unknown): StoredCommandHistoryFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== SCHEMA_VERSION) return undefined;
  if (!Array.isArray(item.entries)) return undefined;

  const entries: CommandHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const raw of item.entries) {
    const entry = normalizeEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return { version: SCHEMA_VERSION, entries };
}

export function defaultCommandHistoryPath(userDataPath: string): string {
  return join(userDataPath, 'command-history.json');
}
