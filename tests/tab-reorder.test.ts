import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX,
  dropIndexFor,
  indexOfId,
  passedThreshold,
  reorder,
  type TabBox
} from '../src/renderer/tab-reorder';

/** Four tabs, 100 wide, side by side from x=0 — midpoints at 50, 150, 250, 350. */
const boxes: TabBox[] = [
  { left: 0, width: 100 },
  { left: 100, width: 100 },
  { left: 200, width: 100 },
  { left: 300, width: 100 }
];

describe('passedThreshold', () => {
  it('holds a press back until it has travelled', () => {
    // A tab is also the button that switches workspace, so the shake in an
    // ordinary click must not reorder anything.
    expect(passedThreshold(200, 200)).toBe(false);
    expect(passedThreshold(200, 203)).toBe(false);
    expect(passedThreshold(200, 205)).toBe(true);
  });

  it('counts travel in either direction', () => {
    expect(passedThreshold(200, 195)).toBe(true);
    expect(passedThreshold(200, 196)).toBe(false);
  });

  it('has a threshold a caller can override', () => {
    expect(DRAG_THRESHOLD_PX).toBeGreaterThan(0);
    expect(passedThreshold(0, 2, 1)).toBe(true);
    expect(passedThreshold(0, 2, 40)).toBe(false);
  });
});

describe('dropIndexFor', () => {
  it('is the tab whose middle the pointer has not yet passed', () => {
    expect(dropIndexFor(boxes, 0)).toBe(0);
    expect(dropIndexFor(boxes, 49)).toBe(0);
    expect(dropIndexFor(boxes, 51)).toBe(1);
    expect(dropIndexFor(boxes, 149)).toBe(1);
    expect(dropIndexFor(boxes, 151)).toBe(2);
    expect(dropIndexFor(boxes, 349)).toBe(3);
  });

  it('parks at an end when dragged beyond the strip', () => {
    // Dragging past the last tab means "make it last", not "nowhere".
    expect(dropIndexFor(boxes, -500)).toBe(0);
    expect(dropIndexFor(boxes, 5000)).toBe(3);
  });

  it('has an answer for a strip with one tab, and for none', () => {
    expect(dropIndexFor([{ left: 0, width: 100 }], 80)).toBe(0);
    expect(dropIndexFor([], 80)).toBe(0);
  });

  it('reads the tabs where they are, not where they started', () => {
    // The strip reorders live while a tab is dragged, so the boxes handed in are
    // the current layout — a tab that has already moved is measured there.
    const moved: TabBox[] = [
      { left: 0, width: 60 },
      { left: 60, width: 140 },
      { left: 200, width: 100 }
    ];
    expect(dropIndexFor(moved, 29)).toBe(0);
    expect(dropIndexFor(moved, 31)).toBe(1);
    expect(dropIndexFor(moved, 129)).toBe(1);
    expect(dropIndexFor(moved, 131)).toBe(2);
  });
});

describe('reorder', () => {
  const items = ['a', 'b', 'c', 'd'];

  it('moves an item forward', () => {
    expect(reorder(items, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(items, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('moves an item back', () => {
    expect(reorder(items, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(reorder(items, 2, 0)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('returns the same array when nothing moves', () => {
    // This runs on every pointer move, so an unchanged order must not be a new
    // array or the strip re-renders continuously while a tab is held still.
    expect(reorder(items, 1, 1)).toBe(items);
    expect(reorder(items, 0, -3)).toBe(items);
    expect(reorder(items, 3, 9)).toBe(items);
  });

  it('leaves a list alone when the index is not in it', () => {
    expect(reorder(items, -1, 2)).toBe(items);
    expect(reorder(items, 4, 2)).toBe(items);
    expect(reorder([], 0, 0)).toEqual([]);
  });

  it('keeps every item exactly once, wherever it is dropped', () => {
    for (let from = 0; from < items.length; from += 1) {
      for (let to = 0; to < items.length; to += 1) {
        const result = reorder(items, from, to);
        expect([...result].sort(), `${from} to ${to}`).toEqual(['a', 'b', 'c', 'd']);
        expect(result[Math.min(Math.max(to, 0), items.length - 1)]).toBe(items[from]);
      }
    }
  });
});

describe('indexOfId', () => {
  const items = [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }];

  it('finds the position of an id', () => {
    expect(indexOfId(items, 'ws-2')).toBe(1);
  });

  it('reports -1 for an id that has gone', () => {
    // A workspace can be closed while a drag is in flight.
    expect(indexOfId(items, 'ws-9')).toBe(-1);
    expect(indexOfId(items, null)).toBe(-1);
    expect(indexOfId(items, undefined)).toBe(-1);
    expect(indexOfId([], 'ws-1')).toBe(-1);
  });
});
