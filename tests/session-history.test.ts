import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionHistoryStore } from '../src/main/session-history';

const session = { id: 'ssh:1', name: 'dev', kind: 'ssh' as const, host: 'dev.example', cwd: '/secret', status: 'connected' as const, lastSeen: '2026-01-01T00:00:00.000Z', backend: 'ssh' as const, scope: 'remote' as const, sshTarget: 'user@dev.example', screenName: 'screen', wslDistribution: 'Ubuntu' };

async function file() { return join(await mkdtemp(join(tmpdir(), 'zerog-history-')), 'history.json'); }

describe('session history store', () => {
  it('round trips bounded structured entries without secrets or cwd', async () => {
    const path = await file();
    const store = new SessionHistoryStore({ filePath: path, limit: 2, now: () => new Date('2026-02-03T04:05:06.000Z') });
    await store.record('created', session, true);
    await store.record('closed', session, false);
    await store.record('attached', session, true);
    await expect(new SessionHistoryStore({ filePath: path }).list()).resolves.toHaveLength(2);
    const entries = await new SessionHistoryStore({ filePath: path }).list();
    expect(entries[0].session).not.toHaveProperty('cwd');
    expect(JSON.stringify(entries)).not.toContain('secret');
    expect(entries[0].timestamp).toBe('2026-02-03T04:05:06.000Z');
  });

  it('tolerates malformed files', async () => {
    const path = await file();
    await writeFile(path, '{not json');
    expect(await new SessionHistoryStore({ filePath: path }).list()).toEqual([]);
  });
});
