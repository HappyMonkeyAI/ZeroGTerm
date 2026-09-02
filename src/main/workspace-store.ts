import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  StoredWorkspace,
  StoredWorkspaceFile,
  StoredWorkspaceMember,
  StoredWorkspaceView
} from '../shared/types.js';

const SCHEMA_VERSION = 1;
const MAX_WORKSPACES = 32;
const MAX_MEMBERS = 4;

// The stored shapes are the IPC contract, so they live in shared/types.ts and
// are re-exported here under the names this module works in.
export type StoredMember = StoredWorkspaceMember;
export type StoredView = StoredWorkspaceView;
export type { StoredWorkspace };
export type WorkspaceFile = StoredWorkspaceFile;

/**
 * Main-process-only, best-effort workspace persistence.
 *
 * Never stores cwd, command arguments, or credentials — the same guarantee
 * SessionHistoryStore makes, and for the same reason: this file sits in plain
 * JSON in the user's profile.
 */
export class WorkspaceStore {
  private readonly filePath: string;
  private file: WorkspaceFile = { version: SCHEMA_VERSION, workspaces: [] };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: { filePath: string }) {
    this.filePath = options.filePath;
  }

  async load(): Promise<WorkspaceFile> {
    await this.ensureLoaded();
    return normalizeFile(this.file) ?? { version: SCHEMA_VERSION, workspaces: [] };
  }

  async save(input: unknown): Promise<WorkspaceFile> {
    await this.ensureLoaded();
    // Validate on the way in as well as out. The renderer is the only caller,
    // but this is an IPC boundary and a stored bad value would come back on
    // every launch from then on.
    const normalized = normalizeFile(input);
    if (!normalized) throw new Error('Invalid workspace layout.');
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
      // Missing, unreadable, or corrupt: start from an empty set rather than
      // leaving the app unable to open a window.
      this.file = { version: SCHEMA_VERSION, workspaces: [] };
    }
  }

  private async persist(): Promise<void> {
    const snapshot = this.file;
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        const temp = join(dirname(this.filePath), `.workspaces.tmp-${process.pid}-${randomUUID()}`);
        await writeFile(temp, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.filePath);
      } catch {
        // Layout memory must never affect terminal operation.
      }
    });
    await this.writeQueue;
  }
}

const LAYOUTS = ['stack', 'split-v', 'split-h', 'grid'];
const SPLITS = ['split-v', 'split-h', 'grid'];

/** Strip control characters and cap length; the file is user-editable. */
function safeText(value: string, limit = 256): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit);
}

function optionalText(value: unknown, limit = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = safeText(value, limit);
  return text ? text : undefined;
}

function normalizeMember(value: unknown): StoredMember | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.sessionId !== 'string' || typeof item.name !== 'string') return undefined;
  if (item.kind !== 'local' && item.kind !== 'ssh') return undefined;
  const sessionId = safeText(item.sessionId);
  const name = safeText(item.name, 64);
  if (!sessionId || !name) return undefined;
  const member: StoredMember = { sessionId, kind: item.kind, name };
  const host = optionalText(item.host);
  const screenName = optionalText(item.screenName, 64);
  const sshTarget = optionalText(item.sshTarget);
  const backend = optionalText(item.backend, 32);
  if (host) member.host = host;
  if (screenName) member.screenName = screenName;
  if (sshTarget) member.sshTarget = sshTarget;
  if (backend) member.backend = backend;
  return member;
}

function normalizeView(value: unknown, memberIds: Set<string>): StoredView {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const layout = typeof item.layout === 'string' && LAYOUTS.includes(item.layout) ? item.layout : 'stack';
  const lastSplit = typeof item.lastSplit === 'string' && SPLITS.includes(item.lastSplit) ? item.lastSplit : 'split-v';
  // A view may only name sessions the workspace actually holds, so a hand-edited
  // file cannot point a pane at something that is not there.
  const member = (candidate: unknown): string | undefined => {
    const text = optionalText(candidate);
    return text && memberIds.has(text) ? text : undefined;
  };
  const view: StoredView = { layout, lastSplit, maximizedSessionId: member(item.maximizedSessionId) ?? null };
  const active = member(item.activeSessionId);
  const focused = member(item.focusedSessionId);
  if (active) view.activeSessionId = active;
  if (focused) view.focusedSessionId = focused;
  const browsers = normalizeBrowsers(item.browsers, memberIds);
  if (browsers) view.browsers = browsers;
  return view;
}

/**
 * Directory browser state, keyed only by panes the workspace holds.
 *
 * The same rule the pane references above follow: a hand-edited file may not
 * carry state for a session this workspace does not own. A malformed entry is
 * dropped rather than repaired — a pane with no entry shows no browser, which is
 * the safe reading of a file we cannot trust.
 */
function normalizeBrowsers(
  value: unknown,
  memberIds: Set<string>
): Record<string, { open: boolean; ratio?: number }> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, { open: boolean; ratio?: number }> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!memberIds.has(id) || !raw || typeof raw !== 'object') continue;
    const entry = raw as { open?: unknown; ratio?: unknown };
    if (typeof entry.open !== 'boolean') continue;
    const ratio = typeof entry.ratio === 'number' && Number.isFinite(entry.ratio) && entry.ratio > 0 && entry.ratio < 100
      ? entry.ratio
      : undefined;
    out[id] = ratio === undefined ? { open: entry.open } : { open: entry.open, ratio };
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeWorkspace(value: unknown): StoredWorkspace | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string') return undefined;
  const id = safeText(item.id, 64);
  const name = safeText(item.name, 64);
  if (!id || !name) return undefined;

  const rawMembers = Array.isArray(item.members) ? item.members : [];
  const members: StoredMember[] = [];
  const seen = new Set<string>();
  for (const raw of rawMembers) {
    const member = normalizeMember(raw);
    // One pane per session: a duplicated id would render the same terminal
    // twice and the two panes would fight over the pty size.
    if (!member || seen.has(member.sessionId)) continue;
    seen.add(member.sessionId);
    members.push(member);
    if (members.length >= MAX_MEMBERS) break;
  }

  return { id, name, members, view: normalizeView(item.view, seen) };
}

export function normalizeFile(value: unknown): WorkspaceFile | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.version !== SCHEMA_VERSION) return undefined;
  if (!Array.isArray(item.workspaces)) return undefined;

  const workspaces: StoredWorkspace[] = [];
  const seen = new Set<string>();
  for (const raw of item.workspaces) {
    const workspace = normalizeWorkspace(raw);
    if (!workspace || seen.has(workspace.id)) continue;
    seen.add(workspace.id);
    workspaces.push(workspace);
    if (workspaces.length >= MAX_WORKSPACES) break;
  }

  const file: WorkspaceFile = { version: SCHEMA_VERSION, workspaces };
  // An active id naming nothing would leave the app with no workspace on
  // screen, so it falls back to the first rather than being kept.
  const active = optionalText(item.activeWorkspaceId, 64);
  if (active && seen.has(active)) file.activeWorkspaceId = active;
  else if (workspaces.length) file.activeWorkspaceId = workspaces[0].id;
  return file;
}

export function defaultWorkspacePath(userDataPath: string): string {
  return join(userDataPath, 'workspaces.json');
}
