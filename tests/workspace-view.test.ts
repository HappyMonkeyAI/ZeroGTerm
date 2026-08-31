import { describe, expect, it } from 'vitest';
import {
  adoptLiveSessions,
  claimInto,
  closeWorkspace,
  dropPending,
  fromStoredFile,
  isWorkspaceName,
  layoutForSessionCount,
  makeView,
  nextWorkspaceName,
  reconcileView,
  reconcileWorkspaces,
  releaseSession,
  renameWorkspace,
  toStoredFile,
  updateView,
  workspaceDotState,
  workspacePaneCount,
  type Workspace,
  type WorkspaceView
} from '../src/renderer/workspace-view';
import type { SessionInfo, StoredWorkspaceFile, StoredWorkspaceMember } from '../src/shared/types';

function workspace(
  id: string,
  name: string,
  sessionIds: string[] = [],
  view?: Partial<WorkspaceView>,
  pending: StoredWorkspaceMember[] = []
): Workspace {
  return { id, name, sessionIds, pending, view: { ...makeView('stack'), ...view } };
}

function member(sessionId: string, overrides: Partial<StoredWorkspaceMember> = {}): StoredWorkspaceMember {
  return { sessionId, kind: 'local', name: sessionId, ...overrides };
}

function session(id: string, status: SessionInfo['status']): SessionInfo {
  return {
    id,
    name: id,
    kind: 'local',
    host: 'local',
    cwd: '/home/dev',
    status,
    lastSeen: '2026-01-01T00:00:00.000Z',
    persistence: 'screen',
    scope: 'local',
    source: 'active'
  };
}

describe('isWorkspaceName', () => {
  it('accepts the names the create dialog accepts', () => {
    expect(isWorkspaceName('Workspace 2')).toBe(true);
    expect(isWorkspaceName('client-api.v2')).toBe(true);
    expect(isWorkspaceName('A')).toBe(true);
  });

  it('refuses an empty name, so a blurred half-edit cannot erase one', () => {
    expect(isWorkspaceName('')).toBe(false);
  });

  it('refuses a name that does not start alphanumeric', () => {
    // Workspace names feed nextTerminalName, which slugifies them into session
    // names; a leading dash there reads as an option to the tools downstream.
    expect(isWorkspaceName('-prod')).toBe(false);
    expect(isWorkspaceName(' prod')).toBe(false);
  });

  it('refuses characters outside the allowed set', () => {
    expect(isWorkspaceName('prod/db')).toBe(false);
    expect(isWorkspaceName('prod;rm')).toBe(false);
  });

  it('refuses a name longer than the field allows', () => {
    expect(isWorkspaceName('a'.repeat(49))).toBe(true);
    expect(isWorkspaceName('a'.repeat(50))).toBe(false);
  });
});

describe('nextWorkspaceName', () => {
  it('counts up from the number of workspaces', () => {
    expect(nextWorkspaceName([workspace('a', 'Workspace')])).toBe('Workspace 2');
  });

  it('skips a number already taken, whatever its case', () => {
    // Two workspaces means the counter starts at 3, which a renamed workspace
    // has already claimed.
    const workspaces = [workspace('a', 'Workspace'), workspace('b', 'workspace 3')];
    expect(nextWorkspaceName(workspaces)).toBe('Workspace 4');
  });
});

describe('renameWorkspace', () => {
  it('renames only the named workspace', () => {
    const workspaces = [workspace('a', 'Workspace'), workspace('b', 'Workspace 2')];
    const renamed = renameWorkspace(workspaces, 'b', 'client-api');
    expect(renamed.map((item) => item.name)).toEqual(['Workspace', 'client-api']);
  });

  it('trims the draft before committing it', () => {
    const renamed = renameWorkspace([workspace('a', 'Workspace')], 'a', '  prod  ');
    expect(renamed[0].name).toBe('prod');
  });

  it('leaves the list untouched for an invalid name', () => {
    // Commit runs on blur too, so an unusable draft must be a no-op rather than
    // a clamp — the old name is the better answer.
    const workspaces = [workspace('a', 'Workspace')];
    expect(renameWorkspace(workspaces, 'a', '   ')).toBe(workspaces);
    expect(renameWorkspace(workspaces, 'a', '-nope')).toBe(workspaces);
  });

  it('leaves the list untouched for an unknown workspace', () => {
    const workspaces = [workspace('a', 'Workspace')];
    expect(renameWorkspace(workspaces, 'missing', 'prod')[0].name).toBe('Workspace');
  });
});

describe('workspaceDotState', () => {
  it('is empty when the workspace holds nothing', () => {
    expect(workspaceDotState(workspace('a', 'Workspace'), [])).toBe('empty');
  });

  it('is empty when its session ids name nothing live', () => {
    // A stale id left by a closed session must not read as a live workspace.
    expect(workspaceDotState(workspace('a', 'Workspace', ['local:gone']), [session('local:other', 'connected')])).toBe('empty');
  });

  it('is connected when any member is attached', () => {
    const sessions = [session('local:one', 'detached'), session('local:two', 'connected')];
    expect(workspaceDotState(workspace('a', 'Workspace', ['local:one', 'local:two']), sessions)).toBe('connected');
  });

  it('is detached when it holds sessions but none are attached', () => {
    const sessions = [session('local:one', 'detached')];
    expect(workspaceDotState(workspace('a', 'Workspace', ['local:one']), sessions)).toBe('detached');
  });

  it('ignores sessions belonging to another workspace', () => {
    const sessions = [session('local:mine', 'detached'), session('local:theirs', 'connected')];
    expect(workspaceDotState(workspace('a', 'Workspace', ['local:mine']), sessions)).toBe('detached');
  });
});

describe('closeWorkspace', () => {
  const three = () => [
    workspace('a', 'Workspace', ['local:one']),
    workspace('b', 'Workspace 2', ['local:two', 'local:three']),
    workspace('c', 'Workspace 3')
  ];

  it('removes the workspace and reports the sessions it held', () => {
    const result = closeWorkspace(three(), 'b', 'a');
    expect(result.workspaces.map((item) => item.id)).toEqual(['a', 'c']);
    expect(result.releasedSessionIds).toEqual(['local:two', 'local:three']);
  });

  it('leaves the active workspace alone when a different one is closed', () => {
    expect(closeWorkspace(three(), 'c', 'a').activeWorkspaceId).toBe('a');
  });

  it('falls back to the tab on the left when the active one is closed', () => {
    expect(closeWorkspace(three(), 'b', 'b').activeWorkspaceId).toBe('a');
  });

  it('falls back to the first remaining tab when the leftmost is closed', () => {
    expect(closeWorkspace(three(), 'a', 'a').activeWorkspaceId).toBe('b');
  });

  it('refuses to close the last workspace', () => {
    // An app with no workspace has nowhere for the panes or the sidebar header
    // to point, so the state is not representable.
    const only = [workspace('a', 'Workspace', ['local:one'])];
    const result = closeWorkspace(only, 'a', 'a');
    expect(result.workspaces).toBe(only);
    expect(result.releasedSessionIds).toEqual([]);
  });

  it('returns the same list for an unknown workspace', () => {
    const workspaces = three();
    expect(closeWorkspace(workspaces, 'missing', 'a').workspaces).toBe(workspaces);
  });

  it('does not mutate the workspace it closed', () => {
    const workspaces = three();
    const result = closeWorkspace(workspaces, 'b', 'a');
    result.releasedSessionIds.push('local:injected');
    expect(workspaces[1].sessionIds).toEqual(['local:two', 'local:three']);
  });
});

describe('makeView', () => {
  it('keeps a split as the layout to fold back out to', () => {
    expect(makeView('grid')).toMatchObject({ layout: 'grid', lastSplit: 'grid' });
  });

  it('gives a stacked workspace a split to fold out to anyway', () => {
    // 'stack' is not a split, so the field would otherwise be meaningless and
    // the single-pane toggle would have nowhere to go on its first press.
    expect(makeView('stack')).toMatchObject({ layout: 'stack', lastSplit: 'split-v' });
  });

  it('starts with nothing maximized and nothing selected', () => {
    const view = makeView('stack');
    expect(view.maximizedSessionId).toBeNull();
    expect(view.activeSessionId).toBeUndefined();
    expect(view.focusedSessionId).toBeUndefined();
  });
});

describe('layoutForSessionCount', () => {
  it('grows the grid with the session count', () => {
    expect(layoutForSessionCount(0)).toBe('stack');
    expect(layoutForSessionCount(1)).toBe('stack');
    expect(layoutForSessionCount(2)).toBe('split-v');
    expect(layoutForSessionCount(3)).toBe('grid');
    expect(layoutForSessionCount(4)).toBe('grid');
  });
});

describe('updateView', () => {
  const two = () => [
    workspace('a', 'Workspace', [], { layout: 'stack' }),
    workspace('b', 'Workspace 2', [], { layout: 'grid' })
  ];

  it('patches one workspace and leaves the other identical', () => {
    const workspaces = two();
    const next = updateView(workspaces, 'a', { layout: 'split-h' });
    expect(next[0].view.layout).toBe('split-h');
    // Referential identity, not just equal contents: an untouched workspace
    // must not re-render its panes.
    expect(next[1]).toBe(workspaces[1]);
  });

  it('accepts a patch computed from the current view', () => {
    const next = updateView(two(), 'b', (view) => ({ layout: view.layout === 'grid' ? 'stack' : 'grid' }));
    expect(next[1].view.layout).toBe('stack');
  });

  it('can clear a field back to undefined', () => {
    const workspaces = [workspace('a', 'Workspace', [], { activeSessionId: 'local:one' })];
    expect(updateView(workspaces, 'a', { activeSessionId: undefined })[0].view.activeSessionId).toBeUndefined();
  });

  it('leaves fields the patch does not mention', () => {
    const workspaces = [workspace('a', 'Workspace', [], { activeSessionId: 'local:one', lastSplit: 'split-h' })];
    const view = updateView(workspaces, 'a', { layout: 'grid' })[0].view;
    expect(view).toMatchObject({ layout: 'grid', activeSessionId: 'local:one', lastSplit: 'split-h' });
  });
});

describe('claimInto', () => {
  it('adds the session to the named workspace', () => {
    const next = claimInto([workspace('a', 'Workspace')], 'a', 'local:one');
    expect(next[0].sessionIds).toEqual(['local:one']);
  });

  it('takes the session away from whichever workspace held it', () => {
    // Membership is exclusive: two copies of one terminal would fight over the
    // same pty size and make "the four panes of this workspace" undecidable.
    const workspaces = [workspace('a', 'Workspace', ['local:one']), workspace('b', 'Workspace 2')];
    const next = claimInto(workspaces, 'b', 'local:one');
    expect(next[0].sessionIds).toEqual([]);
    expect(next[1].sessionIds).toEqual(['local:one']);
  });

  it('is idempotent', () => {
    const workspaces = [workspace('a', 'Workspace', ['local:one'])];
    expect(claimInto(workspaces, 'a', 'local:one')[0]).toBe(workspaces[0]);
  });

  it('does not touch workspaces that never held the session', () => {
    const workspaces = [workspace('a', 'Workspace'), workspace('b', 'Workspace 2', ['local:two'])];
    expect(claimInto(workspaces, 'a', 'local:one')[1]).toBe(workspaces[1]);
  });

  it('appends rather than reordering, so panes keep their slots', () => {
    const next = claimInto([workspace('a', 'Workspace', ['local:one', 'local:two'])], 'a', 'local:three');
    expect(next[0].sessionIds).toEqual(['local:one', 'local:two', 'local:three']);
  });
});

describe('releaseSession', () => {
  it('drops the session and forgets the view fields naming it', () => {
    const workspaces = [
      workspace('a', 'Workspace', ['local:one', 'local:two'], {
        activeSessionId: 'local:one',
        focusedSessionId: 'local:one',
        maximizedSessionId: 'local:one'
      })
    ];
    const next = releaseSession(workspaces, 'local:one');
    expect(next[0].sessionIds).toEqual(['local:two']);
    expect(next[0].view.activeSessionId).toBeUndefined();
    expect(next[0].view.focusedSessionId).toBeUndefined();
    expect(next[0].view.maximizedSessionId).toBeNull();
  });

  it('keeps view fields pointing at sessions that survive', () => {
    const workspaces = [
      workspace('a', 'Workspace', ['local:one', 'local:two'], { activeSessionId: 'local:two' })
    ];
    expect(releaseSession(workspaces, 'local:one')[0].view.activeSessionId).toBe('local:two');
  });

  it('leaves untouched a workspace that never held the session', () => {
    const workspaces = [workspace('a', 'Workspace', ['local:one'])];
    expect(releaseSession(workspaces, 'local:elsewhere')[0]).toBe(workspaces[0]);
  });
});

describe('reconcileView', () => {
  it('returns the same object when nothing needs forgetting', () => {
    // Identity matters: this runs against every workspace whenever the session
    // list moves, and a new object each time would loop the effect calling it.
    const view: WorkspaceView = { ...makeView('stack'), activeSessionId: 'local:one' };
    expect(reconcileView(view, ['local:one'])).toBe(view);
  });

  it('returns the same object when there was nothing set to begin with', () => {
    const view = makeView('grid');
    expect(reconcileView(view, [])).toBe(view);
  });

  it('clears ids the workspace no longer holds', () => {
    const view: WorkspaceView = {
      ...makeView('stack'),
      activeSessionId: 'local:gone',
      focusedSessionId: 'local:gone',
      maximizedSessionId: 'local:gone'
    };
    expect(reconcileView(view, ['local:other'])).toMatchObject({
      activeSessionId: undefined,
      focusedSessionId: undefined,
      maximizedSessionId: null
    });
  });

  it('leaves the layout alone', () => {
    const view: WorkspaceView = { ...makeView('grid'), activeSessionId: 'local:gone' };
    expect(reconcileView(view, [])).toMatchObject({ layout: 'grid', lastSplit: 'grid' });
  });
});

describe('reconcileWorkspaces', () => {
  it('returns the same array when every id is still live', () => {
    const workspaces = [workspace('a', 'Workspace', ['local:one'])];
    expect(reconcileWorkspaces(workspaces, [session('local:one', 'connected')])).toBe(workspaces);
  });

  it('drops ids for sessions that no longer exist', () => {
    // A screen killed from another terminal, or a pane closed while a different
    // workspace was on screen, leaves a dangling id that would still count
    // towards the four-pane cap.
    const workspaces = [workspace('a', 'Workspace', ['local:one', 'local:gone'], { activeSessionId: 'local:gone' })];
    const next = reconcileWorkspaces(workspaces, [session('local:one', 'detached')]);
    expect(next[0].sessionIds).toEqual(['local:one']);
    expect(next[0].view.activeSessionId).toBeUndefined();
  });

  it('leaves workspaces that needed no change referentially identical', () => {
    const workspaces = [workspace('a', 'Workspace', ['local:one']), workspace('b', 'Workspace 2', ['local:gone'])];
    const next = reconcileWorkspaces(workspaces, [session('local:one', 'connected')]);
    expect(next[0]).toBe(workspaces[0]);
    expect(next[1].sessionIds).toEqual([]);
  });

  it('keeps remembered panes, which are not live by definition', () => {
    const workspaces = [workspace('a', 'Workspace', [], {}, [member('ssh:old', { kind: 'ssh' })])];
    expect(reconcileWorkspaces(workspaces, [])[0].pending).toHaveLength(1);
  });

  it('lets a view keep naming a pane that is still waiting to reconnect', () => {
    // Otherwise a restored workspace forgets which pane was selected before the
    // relaunch, because reconciling runs before the pane is adopted.
    const workspaces = [
      workspace('a', 'Workspace', [], { activeSessionId: 'local:api' }, [member('local:api', { screenName: 'api' })])
    ];
    expect(reconcileWorkspaces(workspaces, [])[0].view.activeSessionId).toBe('local:api');
  });
});

describe('workspacePaneCount', () => {
  it('counts live and remembered panes together', () => {
    // The four-pane cap has to see a restored-but-not-reconnected pane, or a
    // workspace could be pushed to five.
    const target = workspace('a', 'Workspace', ['local:one'], {}, [member('ssh:old', { kind: 'ssh' })]);
    expect(workspacePaneCount(target)).toBe(2);
  });
});

describe('dropPending', () => {
  it('removes one remembered pane by its stored id', () => {
    const workspaces = [workspace('a', 'Workspace', [], {}, [member('ssh:1'), member('ssh:2')])];
    expect(dropPending(workspaces, 'a', 'ssh:1')[0].pending.map((m) => m.sessionId)).toEqual(['ssh:2']);
  });

  it('leaves the list untouched when nothing matches', () => {
    const workspaces = [workspace('a', 'Workspace', [], {}, [member('ssh:1')])];
    expect(dropPending(workspaces, 'a', 'ssh:missing')[0]).toBe(workspaces[0]);
    expect(dropPending(workspaces, 'other', 'ssh:1')[0]).toBe(workspaces[0]);
  });

  it('stops the view naming the pane it just gave up on', () => {
    const workspaces = [workspace('a', 'Workspace', [], { activeSessionId: 'ssh:1' }, [member('ssh:1')])];
    expect(dropPending(workspaces, 'a', 'ssh:1')[0].view.activeSessionId).toBeUndefined();
  });
});

describe('adoptLiveSessions', () => {
  it('takes over a remembered pane whose session is running', () => {
    const workspaces = [workspace('a', 'Workspace', [], {}, [member('local:api', { screenName: 'api' })])];
    const next = adoptLiveSessions(workspaces, () => 'local:api');
    expect(next[0].sessionIds).toEqual(['local:api']);
    expect(next[0].pending).toEqual([]);
  });

  it('moves view references onto the id the session came back with', () => {
    // An SSH session gets a fresh uuid each launch, so the stored view names a
    // pane that no longer exists under that id.
    const workspaces = [
      workspace('a', 'Workspace', [], { activeSessionId: 'ssh:old', focusedSessionId: 'ssh:old', maximizedSessionId: 'ssh:old' }, [
        member('ssh:old', { kind: 'ssh', host: 'build.example.com' })
      ])
    ];
    const next = adoptLiveSessions(workspaces, () => 'ssh:new');
    expect(next[0].view).toMatchObject({
      activeSessionId: 'ssh:new',
      focusedSessionId: 'ssh:new',
      maximizedSessionId: 'ssh:new'
    });
  });

  it('leaves panes that could not be resolved waiting', () => {
    const workspaces = [workspace('a', 'Workspace', [], {}, [member('ssh:1'), member('local:api')])];
    const next = adoptLiveSessions(workspaces, (m) => (m.sessionId === 'local:api' ? 'local:api' : undefined));
    expect(next[0].sessionIds).toEqual(['local:api']);
    expect(next[0].pending.map((m) => m.sessionId)).toEqual(['ssh:1']);
  });

  it('returns the same array when nothing was adopted', () => {
    // This runs on every session-list change; a new array each time would loop
    // the effect that calls it.
    const workspaces = [workspace('a', 'Workspace', [], {}, [member('ssh:1')])];
    expect(adoptLiveSessions(workspaces, () => undefined)).toBe(workspaces);
  });

  it('does not rebuild a workspace just because another one adopted', () => {
    const workspaces = [
      workspace('a', 'Workspace', [], {}, [member('local:api')]),
      workspace('b', 'Workspace 2', [], {}, [member('ssh:1')])
    ];
    const next = adoptLiveSessions(workspaces, (m) => (m.sessionId === 'local:api' ? 'local:api' : undefined));
    expect(next[1]).toBe(workspaces[1]);
  });

  it('does not add a session the workspace already holds twice', () => {
    const workspaces = [workspace('a', 'Workspace', ['local:api'], {}, [member('local:api')])];
    expect(adoptLiveSessions(workspaces, () => 'local:api')[0].sessionIds).toEqual(['local:api']);
  });
});

describe('toStoredFile', () => {
  const live = [
    { ...session('local:api', 'connected'), name: 'api', screenName: 'api', backend: 'screen' as const },
    { ...session('ssh:1', 'connected'), name: 'build', kind: 'ssh' as const, host: 'build.example.com', sshTarget: 'dev@build.example.com' }
  ];

  it('describes live panes by their durable keys', () => {
    const workspaces = [workspace('a', 'Workspace', ['local:api', 'ssh:1'], { layout: 'split-v' })];
    const file = toStoredFile(workspaces, 'a', live);
    expect(file.workspaces[0].members).toEqual([
      { sessionId: 'local:api', kind: 'local', name: 'api', host: 'local', screenName: 'api', backend: 'screen' },
      { sessionId: 'ssh:1', kind: 'ssh', name: 'build', host: 'build.example.com', sshTarget: 'dev@build.example.com' }
    ]);
  });

  it('never writes a working directory', () => {
    const workspaces = [workspace('a', 'Workspace', ['local:api'])];
    expect(JSON.stringify(toStoredFile(workspaces, 'a', live))).not.toContain('/home/dev');
  });

  it('keeps a pane the user never reconnected', () => {
    const workspaces = [workspace('a', 'Workspace', ['local:api'], {}, [member('ssh:old', { kind: 'ssh', host: 'db.example.com' })])];
    const members = toStoredFile(workspaces, 'a', live).workspaces[0].members;
    expect(members.map((m) => m.sessionId)).toEqual(['local:api', 'ssh:old']);
  });

  it('drops an id that names no live session', () => {
    const workspaces = [workspace('a', 'Workspace', ['local:api', 'local:ghost'])];
    expect(toStoredFile(workspaces, 'a', live).workspaces[0].members).toHaveLength(1);
  });

  it('records the layout and which workspace was active', () => {
    const workspaces = [workspace('a', 'Workspace', [], { layout: 'grid', lastSplit: 'split-h' })];
    const file = toStoredFile(workspaces, 'a', live);
    expect(file.workspaces[0].view).toMatchObject({ layout: 'grid', lastSplit: 'split-h', maximizedSessionId: null });
    expect(file.activeWorkspaceId).toBe('a');
  });
});

describe('fromStoredFile', () => {
  const stored: StoredWorkspaceFile = {
    version: 1,
    activeWorkspaceId: 'ws-2',
    workspaces: [
      {
        id: 'ws-1',
        name: 'Workspace',
        view: { layout: 'split-v', lastSplit: 'split-v', activeSessionId: 'local:api', maximizedSessionId: null },
        members: [{ sessionId: 'local:api', kind: 'local', name: 'api', screenName: 'api' }]
      },
      { id: 'ws-2', name: 'client-api', view: { layout: 'grid', lastSplit: 'grid' }, members: [] }
    ]
  };

  it('brings back every pane as one still to be reconnected', () => {
    // Nothing is adopted here even if it is running: that decision belongs to
    // the restore planner, so there is only one rule for "the same shell".
    const { workspaces } = fromStoredFile(stored, 'stack');
    expect(workspaces[0].sessionIds).toEqual([]);
    expect(workspaces[0].pending.map((m) => m.sessionId)).toEqual(['local:api']);
  });

  it('restores names, layouts, and the active workspace', () => {
    const { workspaces, activeWorkspaceId } = fromStoredFile(stored, 'stack');
    expect(workspaces.map((w) => w.name)).toEqual(['Workspace', 'client-api']);
    expect(workspaces[0].view.layout).toBe('split-v');
    expect(activeWorkspaceId).toBe('ws-2');
  });

  it('falls back to the first workspace when the active id names nothing', () => {
    const { activeWorkspaceId } = fromStoredFile({ ...stored, activeWorkspaceId: 'ws-missing' }, 'stack');
    expect(activeWorkspaceId).toBe('ws-1');
  });

  it('falls back to the given layout for one it does not recognise', () => {
    const odd: StoredWorkspaceFile = {
      version: 1,
      workspaces: [{ id: 'ws-1', name: 'Workspace', view: { layout: 'hexagonal', lastSplit: 'stack' }, members: [] }]
    };
    const view = fromStoredFile(odd, 'grid').workspaces[0].view;
    expect(view).toMatchObject({ layout: 'grid', lastSplit: 'grid' });
  });

  it('round-trips a workspace through the store and back', () => {
    const live = [{ ...session('local:api', 'connected'), name: 'api', screenName: 'api' }];
    const before = [workspace('a', 'Workspace', ['local:api'], { layout: 'split-h', lastSplit: 'split-h' })];
    const after = fromStoredFile(toStoredFile(before, 'a', live), 'stack');
    expect(after.workspaces[0].name).toBe('Workspace');
    expect(after.workspaces[0].view.layout).toBe('split-h');
    // And adopting it back gives the workspace it started as.
    const adopted = adoptLiveSessions(after.workspaces, () => 'local:api');
    expect(adopted[0].sessionIds).toEqual(['local:api']);
    expect(adopted[0].pending).toEqual([]);
  });
});
