// The workspace model: what a workspace is, and the rules for naming, closing,
// and reporting on one.
//
// Kept out of main.tsx so the rules can be unit tested — main.tsx calls
// createRoot at module scope and cannot be imported from a test — and so that
// "which workspace is active after this" is answered in one place rather than
// at each button.

import type { SessionInfo, StoredWorkspaceFile, StoredWorkspaceMember } from '../shared/types';
import type { Layout } from './settings';
import type { SplitLayout } from './pane-layout';

/**
 * How a workspace is arranged, as opposed to what it contains.
 *
 * This belongs to the workspace rather than to the app because the whole point
 * of a workspace is that it is a place you leave and come back to. Held
 * globally, a split set up for one project followed the user into the next one,
 * and a maximized pane pointed at a terminal that was no longer on screen.
 */
export type WorkspaceView = {
  layout: Layout;
  /** The split the single-pane view folds back out to, per workspace. */
  lastSplit: SplitLayout;
  /** The session the sidebar and breadcrumb name. */
  activeSessionId?: string;
  /** The session that has the keyboard. */
  focusedSessionId?: string;
  maximizedSessionId?: string | null;
};

export type Workspace = {
  id: string;
  name: string;
  sessionIds: string[];
  /**
   * Panes remembered from a previous launch that are not running yet.
   *
   * An SSH pane cannot be silently reopened on startup — that would dial out to
   * a host before the user has asked for anything — so it waits here and shows
   * as a ghost row until clicked. Kept on the workspace rather than beside it so
   * that closing a workspace disposes of its unreconnected panes too, and so a
   * pane still waiting is saved again on the next quit.
   */
  pending: StoredWorkspaceMember[];
  view: WorkspaceView;
};

/** Panes a workspace expects to show, whether or not they are running yet. */
export function workspacePaneCount(workspace: Workspace): number {
  return workspace.sessionIds.length + workspace.pending.length;
}

export function makeView(layout: Layout): WorkspaceView {
  return {
    layout,
    // A stack has no split to fold back to, so pick the one the layout buttons
    // treat as the default rather than leaving the field meaningless.
    lastSplit: layout === 'stack' ? 'split-v' : layout,
    maximizedSessionId: null
  };
}

export function makeWorkspace(name: string, layout: Layout, sessionIds: string[] = []): Workspace {
  return { id: `ws-${crypto.randomUUID()}`, name, sessionIds, pending: [], view: makeView(layout) };
}

/** The layout a workspace should show once it holds `count` sessions. */
export function layoutForSessionCount(count: number): Layout {
  if (count <= 1) return 'stack';
  if (count === 2) return 'split-v';
  return 'grid';
}

/** Apply a patch to one workspace's view, leaving every other workspace alone. */
export function updateView(
  workspaces: Workspace[],
  workspaceId: string,
  patch: Partial<WorkspaceView> | ((view: WorkspaceView) => Partial<WorkspaceView>)
): Workspace[] {
  return workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    const next = { ...workspace.view, ...(typeof patch === 'function' ? patch(workspace.view) : patch) };
    return { ...workspace, view: next };
  });
}

/**
 * Move a session into one workspace and out of every other.
 *
 * Membership is exclusive: the same terminal appearing in two workspaces would
 * make "the four panes of this workspace" undecidable, and both copies would
 * fight over the same pty size.
 */
export function claimInto(workspaces: Workspace[], workspaceId: string, sessionId: string): Workspace[] {
  return workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) {
      if (!workspace.sessionIds.includes(sessionId)) return workspace;
      return { ...workspace, sessionIds: workspace.sessionIds.filter((id) => id !== sessionId) };
    }
    if (workspace.sessionIds.includes(sessionId)) return workspace;
    return { ...workspace, sessionIds: [...workspace.sessionIds, sessionId] };
  });
}

/** Drop a session from wherever it was, and from any view still naming it. */
export function releaseSession(workspaces: Workspace[], sessionId: string): Workspace[] {
  return workspaces.map((workspace) => {
    if (!workspace.sessionIds.includes(sessionId)) return workspace;
    const sessionIds = workspace.sessionIds.filter((id) => id !== sessionId);
    return {
      ...workspace,
      sessionIds,
      view: reconcileView(workspace.view, expectedPaneIds({ ...workspace, sessionIds }))
    };
  });
}

/**
 * Every pane id a workspace's view is allowed to name.
 *
 * Includes panes still waiting to be reconnected: a restored workspace names
 * its selected pane before that pane is running, and clearing the reference in
 * the meantime would lose which pane was selected before the relaunch.
 */
function expectedPaneIds(workspace: Workspace): string[] {
  return [...workspace.sessionIds, ...workspace.pending.map((member) => member.sessionId)];
}

/**
 * Forget session ids a view still names but the workspace no longer holds.
 *
 * Returns the view unchanged when there is nothing to forget, so a caller can
 * skip the state update — this runs against every workspace whenever the
 * session list moves.
 */
export function reconcileView(view: WorkspaceView, memberIds: string[]): WorkspaceView {
  const members = new Set(memberIds);
  const active = view.activeSessionId && members.has(view.activeSessionId) ? view.activeSessionId : undefined;
  const focused = view.focusedSessionId && members.has(view.focusedSessionId) ? view.focusedSessionId : undefined;
  const maximized = view.maximizedSessionId && members.has(view.maximizedSessionId) ? view.maximizedSessionId : null;
  if (active === view.activeSessionId && focused === view.focusedSessionId && maximized === (view.maximizedSessionId ?? null)) {
    return view;
  }
  return { ...view, activeSessionId: active, focusedSessionId: focused, maximizedSessionId: maximized };
}

/**
 * Reconcile every workspace against the sessions that actually exist.
 *
 * Returns the same array when nothing changed, so this can run from an effect on
 * every session-list change without looping.
 */
export function reconcileWorkspaces(workspaces: Workspace[], sessions: SessionInfo[]): Workspace[] {
  const live = new Set(sessions.map((session) => session.id));
  let changed = false;
  const next = workspaces.map((workspace) => {
    const sessionIds = workspace.sessionIds.filter((id) => live.has(id));
    const view = reconcileView(workspace.view, expectedPaneIds({ ...workspace, sessionIds }));
    if (sessionIds.length === workspace.sessionIds.length && view === workspace.view) return workspace;
    changed = true;
    return { ...workspace, sessionIds, view };
  });
  return changed ? next : workspaces;
}

/**
 * The characters a workspace name may use.
 *
 * Exported as the pattern source because the create dialog puts it straight on
 * an input's `pattern` attribute (implicitly anchored) while the inline rename
 * tests it here. One string means the two cannot drift apart and start
 * accepting different names.
 */
export const WORKSPACE_NAME_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9_.]|-| ){0,48}';

const WORKSPACE_NAME = new RegExp(`^(?:${WORKSPACE_NAME_PATTERN})$`);

export function isWorkspaceName(value: string): boolean {
  return WORKSPACE_NAME.test(value);
}

/** `Workspace 2`, `Workspace 3`… skipping any name already taken. */
export function nextWorkspaceName(workspaces: Workspace[]): string {
  let index = workspaces.length + 1;
  const names = new Set(workspaces.map((item) => item.name.toLowerCase()));
  while (names.has(`workspace ${index}`)) index += 1;
  return `Workspace ${index}`;
}

/**
 * Rename a workspace, or leave it alone.
 *
 * An empty or invalid name is refused rather than clamped: the inline rename
 * commits on blur, so a half-typed name must not be able to overwrite a good
 * one just because focus moved.
 */
export function renameWorkspace(workspaces: Workspace[], workspaceId: string, name: string): Workspace[] {
  const value = name.trim();
  if (!isWorkspaceName(value)) return workspaces;
  return workspaces.map((workspace) => (workspace.id === workspaceId ? { ...workspace, name: value } : workspace));
}

/** The state a workspace's tab dot should show, in `.status-dot` terms. */
export type WorkspaceDotState = 'connected' | 'detached' | 'empty';

/**
 * What the tab dot says about a workspace.
 *
 * The dot is the first thing the eye lands on in the tab strip, so it reports
 * the one thing worth knowing at a glance: whether anything in there is live.
 */
export function workspaceDotState(workspace: Workspace, sessions: SessionInfo[]): WorkspaceDotState {
  const members = sessions.filter((session) => workspace.sessionIds.includes(session.id));
  if (members.some((session) => session.status === 'connected')) return 'connected';
  // A workspace holding only panes it has not reconnected yet is not empty —
  // it has contents, none of them live — which is what 'detached' already says.
  if (members.length || workspace.pending.length) return 'detached';
  return 'empty';
}

export type CloseWorkspaceResult = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  /**
   * Sessions the closed workspace held. Their processes are untouched — a
   * `screen` session goes back to being unclaimed inventory and reappears under
   * Screens — but anything pointing at one of these ids has to let go.
   */
  releasedSessionIds: string[];
};

/**
 * Close a workspace, and say what is active afterwards.
 *
 * Closing the last workspace is refused: there is nowhere for the panes, the
 * sidebar header, or the tab strip to point, and an app with no workspace has no
 * representable state. Closing the active one falls back to the tab on its left,
 * which is where the eye already is.
 */
export function closeWorkspace(workspaces: Workspace[], workspaceId: string, activeWorkspaceId: string): CloseWorkspaceResult {
  const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
  const unchanged: CloseWorkspaceResult = { workspaces, activeWorkspaceId, releasedSessionIds: [] };
  if (index < 0 || workspaces.length < 2) return unchanged;

  const closed = workspaces[index];
  const remaining = workspaces.filter((workspace) => workspace.id !== workspaceId);
  const nextActive = activeWorkspaceId === workspaceId
    ? (remaining[Math.max(0, index - 1)] ?? remaining[0]).id
    : activeWorkspaceId;

  return { workspaces: remaining, activeWorkspaceId: nextActive, releasedSessionIds: [...closed.sessionIds] };
}

/** Drop a remembered pane that has been reconnected, or given up on. */
export function dropPending(workspaces: Workspace[], workspaceId: string, sessionId: string): Workspace[] {
  return workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    if (!workspace.pending.some((member) => member.sessionId === sessionId)) return workspace;
    const next = { ...workspace, pending: workspace.pending.filter((member) => member.sessionId !== sessionId) };
    // The view may have been naming the pane that just went away.
    return { ...next, view: reconcileView(next.view, expectedPaneIds(next)) };
  });
}

/**
 * Take over any remembered pane whose session turns out to be running.
 *
 * `resolve` answers "is this member live right now, and under which id" — the
 * renderer supplies it from planSessionRestore so that startup adoption and a
 * click on a ghost row cannot disagree about what counts as the same shell.
 *
 * Returns the same array when nothing was adopted: this runs whenever the
 * session list moves, including after remote screen discovery adds to it.
 */
export function adoptLiveSessions(
  workspaces: Workspace[],
  resolve: (member: StoredWorkspaceMember) => string | undefined
): Workspace[] {
  let anyChanged = false;
  const next = workspaces.map((workspace) => {
    if (!workspace.pending.length) return workspace;
    const pending: StoredWorkspaceMember[] = [];
    const sessionIds = [...workspace.sessionIds];
    let view = workspace.view;
    let adopted = false;
    for (const member of workspace.pending) {
      const liveId = resolve(member);
      if (!liveId) {
        pending.push(member);
        continue;
      }
      if (!sessionIds.includes(liveId)) sessionIds.push(liveId);
      // The stored view named the pane by its old id; move those references on
      // to the id it came back with, or the restored layout would point at a
      // pane that no longer exists under that name.
      view = renameViewSession(view, member.sessionId, liveId);
      adopted = true;
    }
    if (!adopted) return workspace;
    anyChanged = true;
    return { ...workspace, sessionIds, pending, view };
  });
  return anyChanged ? next : workspaces;
}

function renameViewSession(view: WorkspaceView, from: string, to: string): WorkspaceView {
  if (view.activeSessionId !== from && view.focusedSessionId !== from && view.maximizedSessionId !== from) return view;
  return {
    ...view,
    activeSessionId: view.activeSessionId === from ? to : view.activeSessionId,
    focusedSessionId: view.focusedSessionId === from ? to : view.focusedSessionId,
    maximizedSessionId: view.maximizedSessionId === from ? to : view.maximizedSessionId
  };
}

const STORE_VERSION = 1;
const LAYOUTS: Layout[] = ['stack', 'split-v', 'split-h', 'grid'];
const SPLITS: SplitLayout[] = ['split-v', 'split-h', 'grid'];

/**
 * Everything worth remembering about the workspaces, for the store.
 *
 * A pane is written from the live session where there is one, so its durable
 * keys are current, and from the remembered member where there is not — a pane
 * the user never got round to reconnecting is still theirs next launch.
 */
export function toStoredFile(
  workspaces: Workspace[],
  activeWorkspaceId: string,
  sessions: SessionInfo[]
): StoredWorkspaceFile {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  return {
    version: STORE_VERSION,
    activeWorkspaceId,
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      view: {
        layout: workspace.view.layout,
        lastSplit: workspace.view.lastSplit,
        activeSessionId: workspace.view.activeSessionId,
        focusedSessionId: workspace.view.focusedSessionId,
        maximizedSessionId: workspace.view.maximizedSessionId ?? null
      },
      members: [
        ...workspace.sessionIds
          .map((id) => byId.get(id))
          .filter((session): session is SessionInfo => session !== undefined)
          .map(describeMember),
        ...workspace.pending
      ]
    }))
  };
}

function describeMember(session: SessionInfo): StoredWorkspaceMember {
  const member: StoredWorkspaceMember = { sessionId: session.id, kind: session.kind, name: session.name };
  // Only the durable keys, and only when set: no cwd, no arguments, nothing a
  // credential could hide in.
  if (session.host) member.host = session.host;
  if (session.screenName) member.screenName = session.screenName;
  if (session.sshTarget) member.sshTarget = session.sshTarget;
  if (session.backend) member.backend = session.backend;
  return member;
}

/**
 * Rebuild workspaces from the store, with every pane still to be reconnected.
 *
 * Nothing is adopted here even if it happens to be running: the caller resolves
 * that through adoptLiveSessions once the session list has loaded, so the rule
 * for "the same shell" lives in one place.
 */
export function fromStoredFile(
  file: StoredWorkspaceFile,
  fallbackLayout: Layout
): { workspaces: Workspace[]; activeWorkspaceId?: string } {
  const workspaces = file.workspaces.map((stored) => {
    const layout = LAYOUTS.find((candidate) => candidate === stored.view?.layout) ?? fallbackLayout;
    const base = makeView(layout);
    return {
      id: stored.id,
      name: stored.name,
      sessionIds: [],
      pending: [...(stored.members ?? [])],
      view: {
        ...base,
        lastSplit: SPLITS.find((candidate) => candidate === stored.view?.lastSplit) ?? base.lastSplit,
        activeSessionId: stored.view?.activeSessionId,
        focusedSessionId: stored.view?.focusedSessionId,
        maximizedSessionId: stored.view?.maximizedSessionId ?? null
      }
    } satisfies Workspace;
  });
  const activeWorkspaceId = workspaces.some((workspace) => workspace.id === file.activeWorkspaceId)
    ? file.activeWorkspaceId
    : workspaces[0]?.id;
  return { workspaces, activeWorkspaceId };
}
