import { describe, expect, it } from 'vitest';
import { isNavigable, nextSelection, sftpTargetForSession, transferAvailability, transferLabel, transferable } from '../src/renderer/sftp-view';
import type { FileEntry, SessionInfo } from '../src/shared/types';

const session = (patch: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'ssh:1',
  name: 'api',
  kind: 'ssh',
  host: 'dev@example.com',
  cwd: '~',
  status: 'connected',
  lastSeen: '2026-08-19T09:00:00.000Z',
  sshTarget: 'dev@example.com',
  ...patch
});

const entry = (name: string, kind: FileEntry['kind'] = 'file'): FileEntry => ({ name, kind, size: 1 });

describe('which session the panel can talk to', () => {
  it('uses the target the terminal itself connected with', () => {
    expect(sftpTargetForSession(session())).toBe('dev@example.com');
  });

  it('falls back to the host for a session that was discovered, not created', () => {
    expect(sftpTargetForSession(session({ sshTarget: undefined, host: 'example.com' }))).toBe('example.com');
  });

  it('has no target for a local session', () => {
    expect(sftpTargetForSession(session({ kind: 'local', host: 'local', sshTarget: undefined }))).toBeNull();
    expect(sftpTargetForSession(null)).toBeNull();
  });

  it('says why the button is unavailable, rather than just disabling it', () => {
    expect(transferAvailability(session())).toEqual({ available: true, reason: 'Transfer files with dev@example.com' });
    expect(transferAvailability(null).reason).toMatch(/Open an SSH session/);
    const local = transferAvailability(session({ kind: 'local', name: 'build', host: 'local', sshTarget: undefined }));
    expect(local).toMatchObject({ available: false });
    expect(local.reason).toMatch(/build is a local session/);
  });
});

describe('what a transfer will actually move', () => {
  it('leaves directories out rather than half-copying them', () => {
    const entries = [entry('build', 'directory'), entry('notes.md'), entry('app.zip')];
    const chosen = transferable(entries, new Set(['build', 'notes.md']));
    expect(chosen.map((item) => item.name)).toEqual(['notes.md']);
  });

  it('counts what the button will do', () => {
    expect(transferLabel('Upload', 0)).toBe('Upload');
    expect(transferLabel('Upload', 1)).toBe('Upload 1 file');
    expect(transferLabel('Download', 3)).toBe('Download 3 files');
  });

  it('treats a symlink as something that might be a folder', () => {
    expect(isNavigable(entry('current', 'symlink'))).toBe(true);
    expect(isNavigable(entry('build', 'directory'))).toBe(true);
    expect(isNavigable(entry('notes.md'))).toBe(false);
  });
});

describe('selecting rows', () => {
  it('replaces the selection on a plain click and accumulates with a modifier', () => {
    expect([...nextSelection(new Set(['a', 'b']), 'c', false)]).toEqual(['c']);
    expect([...nextSelection(new Set(['a']), 'b', true)]).toEqual(['a', 'b']);
    expect([...nextSelection(new Set(['a', 'b']), 'b', true)]).toEqual(['a']);
  });
});
