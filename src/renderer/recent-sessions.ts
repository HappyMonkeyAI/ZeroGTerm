// The sessions a user had open recently, and how to open each one again.
//
// This feeds the launch picker. It is separate from workspace memory on
// purpose: a workspace only keeps panes it can *reattach* (screen sessions),
// because a plain local or SSH shell died with the app. The picker is for
// exactly those shells — not reattaching them, but opening a fresh one in the
// same place — so it needs its own short list.
//
// Kept out of main.tsx so it can be unit tested: main.tsx calls createRoot at
// module scope and cannot be imported from a test.

import type {
  CreateLocalRequest,
  KnownConnection,
  LocalShellBackend,
  RecentSession,
  SessionInfo,
  StoredRecentSessionFile
} from '../shared/types';
import { BACKEND_LABELS, backendLabel } from './settings';
import { planSessionRestore, screenNameFor, type RestoreAction, type SessionDescriptor } from './session-restore';

const RECENT_VERSION = 1;
/** Matches MAX_RECENT_SESSIONS in the main-process store, which enforces it. */
const MAX_RECENT = 12;
/** How many cards the picker shows. */
export const PICKER_LIMIT = 8;

export const EMPTY_RECENTS: StoredRecentSessionFile = { version: RECENT_VERSION, sessions: [] };

type Identity = Pick<SessionInfo, 'kind' | 'name' | 'host' | 'sshTarget' | 'screenName' | 'backend' | 'wslDistribution'>;

/**
 * What makes two sessions "the same shell" for the picker.
 *
 * The name is part of it: two local bash panes the user named differently are
 * two cards, not one. The directory is not — a shell that moved is still the
 * same shell, and its card should follow it rather than leaving a trail.
 */
export function recentKey(session: Identity): string {
  const target = session.kind === 'ssh' ? (session.sshTarget || session.host || '') : 'local';
  return JSON.stringify([
    session.kind,
    target,
    session.screenName ?? '',
    session.backend ?? '',
    session.wslDistribution ?? '',
    session.name
  ]);
}

/**
 * Fold the sessions open right now into the remembered list.
 *
 * `stamped` is the keys already given a timestamp during this run of the app:
 * a session is stamped once, when first seen, so that later changes to it (a
 * new directory) do not reshuffle the list and write the file again on every
 * keystroke that moves the prompt. Returns the same file object when nothing
 * changed, so the caller can skip the save.
 */
export function recordRecents(
  file: StoredRecentSessionFile,
  open: SessionInfo[],
  options: { now: Date; rememberDirectories: boolean; stamped: ReadonlySet<string> }
): { file: StoredRecentSessionFile; stamped: Set<string> } {
  const stamped = new Set(options.stamped);
  const byKey = new Map(file.sessions.map((entry) => [entry.key, entry]));
  const now = options.now.toISOString();

  for (const session of open) {
    const key = recentKey(session);
    const existing = byKey.get(key);
    const entry: RecentSession = {
      key,
      kind: session.kind,
      name: session.name,
      lastSeen: existing && stamped.has(key) ? existing.lastSeen : now
    };
    if (session.host) entry.host = session.host;
    if (session.sshTarget) entry.sshTarget = session.sshTarget;
    if (session.screenName) entry.screenName = session.screenName;
    if (session.backend) entry.backend = session.backend;
    if (session.wslDistribution) entry.wslDistribution = session.wslDistribution;
    const cwd = rememberableCwd(session.cwd);
    if (cwd) entry.cwd = cwd;
    byKey.set(key, entry);
    stamped.add(key);
  }

  const sessions = [...byKey.values()]
    // Turning the setting off forgets every directory, not just future ones.
    .map((entry) => (options.rememberDirectories || !entry.cwd ? entry : withoutCwd(entry)))
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, MAX_RECENT);

  const next = { version: RECENT_VERSION, sessions };
  return { file: JSON.stringify(next) === JSON.stringify(file) ? file : next, stamped };
}

function withoutCwd(entry: RecentSession): RecentSession {
  const { cwd: _cwd, ...rest } = entry;
  return rest;
}

/** A directory worth writing down: a real path, not the `~` a fresh SSH session starts with. */
function rememberableCwd(cwd: string | undefined): string | undefined {
  if (!cwd || cwd === '~') return undefined;
  return cwd.length <= 512 ? cwd : undefined;
}

/**
 * The cards to offer: most recent first, minus anything already on screen.
 *
 * A session the workspace restore has already brought back (an adopted screen)
 * is open in a pane, and a card for it would only open a duplicate.
 */
export function pickerEntries(file: StoredRecentSessionFile, onScreen: SessionInfo[]): RecentSession[] {
  const open = new Set(onScreen.map(recentKey));
  return file.sessions.filter((entry) => !open.has(entry.key)).slice(0, PICKER_LIMIT);
}

export type LaunchPlan = RestoreAction | { kind: 'create-local'; request: CreateLocalRequest };

const LOCAL_BACKENDS = Object.keys(BACKEND_LABELS) as LocalShellBackend[];

/**
 * How to get a recent session back.
 *
 * Anything with a `screen` behind it goes through planSessionRestore, the one
 * rule the history popover and workspace restore already share, so the picker
 * cannot reconnect a screen differently from them. The difference is what
 * happens when there is nothing to reattach: restore gives up, while the picker
 * opens a new shell in the remembered place, because that is what it is for.
 *
 * A plain SSH shell opens in the remote home directory. Starting it elsewhere
 * would mean sending a `cd` to the far shell as a command string, which is a
 * quoting problem this does not take on; the card shows the directory instead.
 */
export function planRecentLaunch(
  entry: RecentSession,
  sessions: SessionInfo[],
  connections: KnownConnection[]
): LaunchPlan {
  const descriptor: SessionDescriptor = {
    name: entry.name,
    kind: entry.kind,
    host: entry.host,
    screenName: entry.screenName,
    sshTarget: entry.sshTarget,
    backend: entry.backend
  };

  if (entry.kind === 'ssh') return planSessionRestore(descriptor, sessions, connections);

  if (screenNameFor(descriptor)) {
    const restore = planSessionRestore(descriptor, sessions, connections);
    if (restore.kind !== 'unavailable') return restore;
    // The local screen is gone; createLocal makes a screen-backed shell again
    // wherever `screen` is installed.
  }

  const request: CreateLocalRequest = { name: entry.name };
  const backend = LOCAL_BACKENDS.find((candidate) => candidate === entry.backend);
  if (backend) request.backend = backend;
  if (entry.wslDistribution) request.wslDistribution = entry.wslDistribution;
  const cwd = localCwd(entry.cwd);
  if (cwd) request.cwd = cwd;
  return { kind: 'create-local', request };
}

/** An absolute path, POSIX or Windows. Anything relative or `~`-based is left to the shell's default. */
export function localCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  return /^\/|^[A-Za-z]:[\\/]/.test(cwd) ? cwd : undefined;
}

export type CardState = 'running' | 'reconnect' | 'new' | 'unavailable';

/** What clicking the card will do, in the words the card shows. */
export function cardState(plan: LaunchPlan): { state: CardState; label: string } {
  switch (plan.kind) {
    case 'attach':
      return { state: 'running', label: 'Running' };
    case 'attach-remote-screen':
      return { state: 'reconnect', label: 'Reattach screen' };
    case 'create-ssh':
      return plan.screenName ? { state: 'reconnect', label: 'Reattach screen' } : { state: 'new', label: 'New SSH shell' };
    case 'create-local':
      return { state: 'new', label: plan.request.cwd ? 'Open here' : 'New shell' };
    case 'unavailable':
      return { state: 'unavailable', label: 'Unavailable' };
  }
}

/** Where the card says the session lives. */
export function cardWhere(entry: RecentSession): string {
  if (entry.kind === 'ssh') return entry.sshTarget || entry.host || 'SSH';
  const backend = entry.backend && entry.backend !== 'screen' ? backendLabel(entry.backend) : 'screen';
  return entry.wslDistribution ? `${backend} · ${entry.wslDistribution}` : backend;
}

/** "3 hours ago", coarse on purpose: the card is a reminder, not a log. */
export function timeAgo(iso: string, now: Date): string {
  const seconds = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
