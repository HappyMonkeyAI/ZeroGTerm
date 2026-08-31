// Which remembered command the user probably means.
//
// McFly uses a small neural network over these same features. A weighted sum
// gets nearly all of the value and has one decisive advantage: when the wrong
// thing is at the top, the reason is readable, and a test can pin the
// behaviour down. "This scored higher because it was run in this directory"
// beats "the model preferred it".
//
// The weights are deliberately far apart rather than tuned. Directory match
// dominates recency, recency dominates frequency, and a deliberate pick
// dominates a habitual run — that ordering is the design, and the exact numbers
// only have to preserve it.

import type { CommandHistoryEntry } from '../shared/types';

export type RankOptions = {
  query: string;
  cwd?: string;
  host?: string;
  /** Milliseconds since the epoch, injected so scoring is testable. */
  now: number;
  limit?: number;
};

export type RankedCommand = {
  entry: CommandHistoryEntry;
  score: number;
  /** Character positions the query matched, for highlighting. */
  matched: number[];
};

/** Half a command's recency weight is gone after this long. */
const RECENCY_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

const WEIGHTS = {
  /** Same directory. The strongest signal McFly has, and the same here. */
  cwd: 50,
  /** Same host. Weaker than the directory but stronger than habit. */
  host: 12,
  recency: 30,
  /** Log-scaled: the tenth run says much less than the second. */
  frequency: 10,
  /** Chosen from the palette before — on purpose, rather than by habit. */
  pick: 25,
  /** Failed last time. Not disqualifying: sometimes the fix is to run it again. */
  failed: -20,
  /** How well the query fits, before anything about context. */
  match: 40
};

/**
 * Where the query's characters appear in the command, in order.
 *
 * Subsequence rather than substring, so `gcm` finds `git commit -m`. Returns
 * null when the characters are not all there, which is the filter.
 */
export function matchPositions(command: string, query: string): number[] | null {
  if (!query) return [];
  const haystack = command.toLowerCase();
  const needle = query.toLowerCase();
  const positions: number[] = [];
  let at = 0;
  for (const character of needle) {
    if (character === ' ') continue;
    const found = haystack.indexOf(character, at);
    if (found < 0) return null;
    positions.push(found);
    at = found + 1;
  }
  return positions;
}

/**
 * How good a match is, from 0 to 1.
 *
 * Two things make a match feel right: it starts where the user started typing,
 * and its characters sit close together. `gcm` should prefer `git commit -m`
 * over `git checkout my-very-long-branch`, and both over something where the
 * letters happen to be scattered across a long line.
 */
export function matchQuality(command: string, positions: number[]): number {
  if (!positions.length) return 0.5;
  const first = positions[0];
  const last = positions[positions.length - 1];
  const span = last - first + 1;
  const compactness = positions.length / span;
  // A match at the very start is worth more than the same match halfway along.
  const earliness = 1 / (1 + first);
  // Word starts count as beginnings too, so `co` matching `git commit` is not
  // punished for the four characters of `git `.
  const atWordStart = first === 0 || /\s/.test(command.charAt(first - 1)) ? 1 : 0;
  return 0.45 * compactness + 0.35 * earliness + 0.2 * atWordStart;
}

function recencyWeight(lastRun: string, now: number): number {
  const age = now - Date.parse(lastRun);
  if (!Number.isFinite(age)) return 0;
  if (age <= 0) return 1;
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

export function scoreEntry(entry: CommandHistoryEntry, positions: number[], options: RankOptions): number {
  let score = WEIGHTS.match * matchQuality(entry.command, positions);
  if (options.cwd && entry.cwd === options.cwd) score += WEIGHTS.cwd;
  if (options.host && entry.host === options.host) score += WEIGHTS.host;
  score += WEIGHTS.recency * recencyWeight(entry.lastRun, options.now);
  score += WEIGHTS.frequency * Math.log1p(entry.runs);
  score += WEIGHTS.pick * Math.log1p(entry.picks);
  // Only a non-zero status counts against it. An absent status means the shell
  // did not say, which is not the same as a failure.
  if (entry.exitCode !== undefined && entry.exitCode !== 0) score += WEIGHTS.failed;
  return score;
}

/**
 * The best matches, best first.
 *
 * Collapsed to one row per command: the store keeps `npm test` in two
 * directories apart so that the one from here can win, but showing both would
 * be two identical rows. The winner keeps its own entry, so choosing it credits
 * the directory it was actually run in.
 */
export function rankCommands(entries: CommandHistoryEntry[], options: RankOptions): RankedCommand[] {
  const best = new Map<string, RankedCommand>();
  for (const entry of entries) {
    const positions = matchPositions(entry.command, options.query);
    if (positions === null) continue;
    const candidate: RankedCommand = { entry, score: scoreEntry(entry, positions, options), matched: positions };
    const incumbent = best.get(entry.command);
    if (!incumbent || candidate.score > incumbent.score) best.set(entry.command, candidate);
  }
  const ranked = [...best.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // A stable tiebreak, so an unchanged list does not reshuffle between renders.
    return b.entry.lastRun.localeCompare(a.entry.lastRun);
  });
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}
