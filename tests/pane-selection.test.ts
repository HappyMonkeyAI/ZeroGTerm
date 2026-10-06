import { describe, expect, it } from 'vitest';
import { canCycle, cycleSlot, resolveVisible } from '../src/renderer/pane-selection';

const four = ['a', 'b', 'c', 'd'];

describe('resolveVisible', () => {
  it('shows the first two panes when nothing has been chosen', () => {
    expect(resolveVisible(four, undefined)).toEqual(['a', 'b']);
    expect(resolveVisible(four, [])).toEqual(['a', 'b']);
  });

  it('keeps a choice, in the order it was made', () => {
    expect(resolveVisible(four, ['d', 'b'])).toEqual(['d', 'b']);
  });

  it('drops a chosen pane that has gone and fills from the workspace order', () => {
    expect(resolveVisible(['a', 'c', 'd'], ['b', 'd'])).toEqual(['d', 'a']);
    expect(resolveVisible(['a', 'b'], ['x', 'y'])).toEqual(['a', 'b']);
  });

  it('never shows a pane twice', () => {
    expect(resolveVisible(four, ['c', 'c'])).toEqual(['c', 'a']);
  });

  it('shows what there is when the workspace has fewer panes than slots', () => {
    expect(resolveVisible(['a'], undefined)).toEqual(['a']);
    expect(resolveVisible([], ['a'])).toEqual([]);
  });

  it('ignores a choice longer than the slots', () => {
    expect(resolveVisible(four, ['a', 'b', 'c', 'd'])).toEqual(['a', 'b']);
  });
});

describe('canCycle', () => {
  it('is only true when a pane is hidden', () => {
    expect(canCycle(['a', 'b'])).toBe(false);
    expect(canCycle(['a'])).toBe(false);
    expect(canCycle(['a', 'b', 'c'])).toBe(true);
  });
});

describe('cycleSlot', () => {
  it('brings the next hidden pane into the slot', () => {
    expect(cycleSlot(['a', 'b', 'c'], ['a', 'b'], 1, 1)).toEqual(['a', 'c']);
  });

  it('steps through every pane the other slot is not showing, then wraps', () => {
    let visible = ['a', 'b'];
    const seen: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      visible = cycleSlot(four, visible, 1, 1);
      seen.push(visible[1]);
    }
    expect(seen).toEqual(['c', 'd', 'b', 'c']);
    expect(visible[0]).toBe('a');
  });

  it('goes backwards too, wrapping past the start', () => {
    expect(cycleSlot(four, ['a', 'b'], 1, -1)).toEqual(['a', 'd']);
    expect(cycleSlot(four, ['b', 'c'], 0, -1)).toEqual(['a', 'c']);
  });

  it('skips the pane the other slot is showing', () => {
    expect(cycleSlot(four, ['a', 'c'], 0, 1)).toEqual(['b', 'c']);
    expect(cycleSlot(four, ['b', 'a'], 1, 1)).toEqual(['b', 'c']);
  });

  it('never leaves both slots on one pane', () => {
    let visible = ['a', 'b'];
    for (let step = 0; step < 20; step += 1) {
      visible = cycleSlot(four, visible, step % 2, step % 3 === 0 ? -1 : 1);
      expect(new Set(visible).size).toBe(2);
    }
  });

  it('changes nothing when there is nothing to step to', () => {
    expect(cycleSlot(['a', 'b'], ['a', 'b'], 0, 1)).toEqual(['a', 'b']);
    expect(cycleSlot(four, ['a', 'b'], 5, 1)).toEqual(['a', 'b']);
    expect(cycleSlot(four, ['x', 'b'], 0, 1)).toEqual(['x', 'b']);
  });
});
