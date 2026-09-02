import { describe, expect, it } from 'vitest';
import { matchPositions, matchQuality, rankCommands, scoreEntry } from '../src/renderer/command-ranking';
import type { CommandHistoryEntry } from '../src/shared/types';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();
const daysAgo = (days: number) => hoursAgo(days * 24);

let sequence = 0;
function entry(overrides: Partial<CommandHistoryEntry> & { command: string }): CommandHistoryEntry {
  sequence += 1;
  return {
    id: `cmd:${sequence}`,
    lastRun: hoursAgo(1),
    runs: 1,
    picks: 0,
    ...overrides
  };
}

const options = { query: '', now: NOW };

describe('matchPositions', () => {
  it('matches a subsequence, so gcm finds git commit -m', () => {
    // Earliest match at each step, so the `m` found is the one in `commit`
    // rather than the `-m` flag. That is the compact match, which is the one
    // matchQuality is meant to reward.
    expect(matchPositions('git commit -m', 'gcm')).toEqual([0, 4, 6]);
  });

  it('matches a plain substring', () => {
    expect(matchPositions('npm run build', 'run')).toEqual([4, 5, 6]);
  });

  it('ignores case', () => {
    expect(matchPositions('Git Status', 'gs')).toEqual([0, 4]);
  });

  it('ignores spaces in the query, which are how people separate ideas', () => {
    expect(matchPositions('git commit -m', 'g c')).toEqual([0, 4]);
  });

  it('is null when the characters are not all there', () => {
    expect(matchPositions('git status', 'gz')).toBeNull();
    expect(matchPositions('git status', 'tig')).toBeNull();
  });

  it('is an empty match for an empty query, which excludes nothing', () => {
    expect(matchPositions('anything', '')).toEqual([]);
  });
});

describe('matchQuality', () => {
  it('prefers a compact match over a scattered one', () => {
    const compact = matchQuality('git commit -m', matchPositions('git commit -m', 'gcm') ?? []);
    const scattered = matchQuality('git checkout my-long-branch', matchPositions('git checkout my-long-branch', 'gcm') ?? []);
    expect(compact).toBeGreaterThan(scattered);
  });

  it('prefers a match at the start over one halfway along', () => {
    const atStart = matchQuality('build the thing', matchPositions('build the thing', 'bu') ?? []);
    const later = matchQuality('rebuild the thing', matchPositions('rebuild the thing', 'bu') ?? []);
    expect(atStart).toBeGreaterThan(later);
  });

  it('counts a word start as a beginning', () => {
    // `co` matching `git commit` should not be punished for the four characters
    // of `git ` in front of it.
    const wordStart = matchQuality('git commit', matchPositions('git commit', 'co') ?? []);
    const midWord = matchQuality('gitcommit', matchPositions('gitcommit', 'co') ?? []);
    expect(wordStart).toBeGreaterThan(midWord);
  });
});

describe('what outranks what', () => {
  it('puts the same command from this directory first', () => {
    // The strongest signal, and the whole reason the store keeps a command per
    // directory rather than per command.
    const here = entry({ command: 'npm test', cwd: '/srv/app' });
    const there = entry({ command: 'npm test', cwd: '/srv/other', runs: 20 });
    const ranked = rankCommands([there, here], { ...options, cwd: '/srv/app' });
    expect(ranked[0].entry.cwd).toBe('/srv/app');
  });

  it('puts a successful command above one that failed', () => {
    const worked = entry({ command: 'git push', exitCode: 0 });
    const failed = entry({ command: 'git psuh', exitCode: 1 });
    const ranked = rankCommands([failed, worked], { ...options, query: 'gp' });
    expect(ranked[0].entry.command).toBe('git push');
  });

  it('does not treat an unknown status as a failure', () => {
    // A shell that reports no status is not reporting a failure, and marking it
    // down would penalise every pane whose integration is older.
    const unknown = entry({ command: 'make all' });
    const failed = entry({ command: 'make alt', exitCode: 2 });
    const ranked = rankCommands([failed, unknown], { ...options, query: 'ma' });
    expect(ranked[0].entry.command).toBe('make all');
  });

  it('lets recency beat raw frequency at the margin', () => {
    const recent = entry({ command: 'kubectl get pods', runs: 2, lastRun: hoursAgo(1) });
    const stale = entry({ command: 'kubectl get pvc', runs: 8, lastRun: daysAgo(30) });
    const ranked = rankCommands([stale, recent], { ...options, query: 'kg' });
    expect(ranked[0].entry.command).toBe('kubectl get pods');
  });

  it('lets frequency win when recency is equal', () => {
    const often = entry({ command: 'git status', runs: 40, lastRun: hoursAgo(2) });
    const once = entry({ command: 'git stash', runs: 1, lastRun: hoursAgo(2) });
    const ranked = rankCommands([once, often], { ...options, query: 'gst' });
    expect(ranked[0].entry.command).toBe('git status');
  });

  it('raises a command chosen from the palette before', () => {
    // Being picked says more than being run: running happens by habit, picking
    // happens on purpose. This is what makes the list improve with use.
    const picked = entry({ command: 'docker compose logs -f', picks: 4, runs: 4 });
    const merely = entry({ command: 'docker compose ls', picks: 0, runs: 12 });
    const ranked = rankCommands([merely, picked], { ...options, query: 'dcl' });
    expect(ranked[0].entry.command).toBe('docker compose logs -f');
  });

  it('prefers the same host when the directory cannot decide', () => {
    const onHost = entry({ command: 'systemctl status nginx', host: 'build.example.com' });
    const elsewhere = entry({ command: 'systemctl status nginx', host: 'other.example.com' });
    const ranked = rankCommands([elsewhere, onHost], { ...options, host: 'build.example.com' });
    expect(ranked[0].entry.host).toBe('build.example.com');
  });
});

describe('the shape of the result', () => {
  it('excludes anything the query does not match', () => {
    const entries = [entry({ command: 'git status' }), entry({ command: 'npm test' })];
    expect(rankCommands(entries, { ...options, query: 'npm' }).map((r) => r.entry.command)).toEqual(['npm test']);
  });

  it('includes everything for an empty query', () => {
    const entries = [entry({ command: 'git status' }), entry({ command: 'npm test' })];
    expect(rankCommands(entries, options)).toHaveLength(2);
  });

  it('shows one row per command, keeping the best instance', () => {
    // Two directories are two facts in the store and one row in the palette;
    // the winner keeps its own entry so picking it credits the right directory.
    const here = entry({ command: 'npm test', cwd: '/srv/app' });
    const there = entry({ command: 'npm test', cwd: '/srv/other' });
    const ranked = rankCommands([there, here], { ...options, cwd: '/srv/app' });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].entry.id).toBe(here.id);
  });

  it('honours a limit', () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry({ command: `command-${index}` }));
    expect(rankCommands(entries, { ...options, limit: 3 })).toHaveLength(3);
  });

  it('carries the matched positions for highlighting', () => {
    const ranked = rankCommands([entry({ command: 'git commit -m' })], { ...options, query: 'gcm' });
    expect(ranked[0].matched).toEqual([0, 4, 6]);
  });

  it('breaks a tie the same way every time', () => {
    // An unchanged list must not reshuffle between renders.
    const a = entry({ command: 'aa', lastRun: hoursAgo(5) });
    const b = entry({ command: 'ab', lastRun: hoursAgo(3) });
    const first = rankCommands([a, b], options).map((r) => r.entry.id);
    const second = rankCommands([b, a], options).map((r) => r.entry.id);
    expect(first).toEqual(second);
  });

  it('is empty for an empty store', () => {
    expect(rankCommands([], options)).toEqual([]);
  });
});

describe('scoreEntry', () => {
  it('tolerates a timestamp that is not one', () => {
    const broken = entry({ command: 'git status', lastRun: 'not a date' });
    expect(Number.isFinite(scoreEntry(broken, [], options))).toBe(true);
  });

  it('does not reward a run in the future', () => {
    const future = entry({ command: 'git status', lastRun: new Date(NOW + 3600_000).toISOString() });
    const now = entry({ command: 'git stash', lastRun: new Date(NOW).toISOString() });
    expect(scoreEntry(future, [], options)).toBeCloseTo(scoreEntry(now, [], options), 5);
  });
});
