// Dragging the workspace tabs into a different order.
//
// The arithmetic is here rather than in the pointer handlers because it is the
// part that is easy to get subtly wrong — an insertion index is off by one on
// one side of the tab being dragged — and the part a test can pin. main.tsx
// keeps the pointer events and the state; this decides what the order should be.
//
// A tab is also a button that switches workspace, so a drag has to be told apart
// from a click. That is what `passedThreshold` is for: until the pointer has
// moved far enough to be a deliberate drag, the press is still a click, and a
// press that never passes it must leave the order alone.

/** As much of a tab's box as reordering needs. */
export type TabBox = { left: number; width: number };

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * Small enough that dragging feels immediate, and large enough that the shake
 * in an ordinary click — which is a few pixels on a trackpad — does not reorder
 * a workspace nobody meant to move.
 */
export const DRAG_THRESHOLD_PX = 5;

export function passedThreshold(startX: number, x: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.abs(x - startX) >= threshold;
}

/**
 * Which position a tab dragged to `pointerX` should take.
 *
 * Decided by the midpoints of the tabs as they are laid out now: the pointer is
 * past a tab's middle, so that tab has been passed. Clamped to the strip, so
 * dragging beyond either end parks the tab at that end rather than nowhere.
 */
export function dropIndexFor(boxes: readonly TabBox[], pointerX: number): number {
  if (!boxes.length) return 0;
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (pointerX < box.left + box.width / 2) return index;
  }
  return boxes.length - 1;
}

/**
 * The list with one item moved to another position.
 *
 * Returns the same array when nothing would move, so a caller can skip the state
 * update: this runs on every pointer move while a tab is being dragged.
 */
export function reorder<T>(items: readonly T[], from: number, to: number): readonly T[] {
  if (from === to) return items;
  if (from < 0 || from >= items.length) return items;
  const target = Math.min(Math.max(to, 0), items.length - 1);
  if (target === from) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Where an id sits in the list, or -1. */
export function indexOfId<T extends { id: string }>(items: readonly T[], id: string | null | undefined): number {
  if (!id) return -1;
  return items.findIndex((item) => item.id === id);
}
