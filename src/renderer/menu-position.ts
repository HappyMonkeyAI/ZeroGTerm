// Where a menu opened at a point should actually be drawn.
//
// Separated from the menu itself because it is arithmetic with edge cases —
// a menu opened near the right edge has to open leftwards, one near the bottom
// upwards, and one taller than the window has to be pinned rather than
// centred — and none of that is worth discovering by dragging a window to the
// corner of a screen.

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

/** How much space to leave between the menu and the edge of the window. */
export const MENU_MARGIN_PX = 6;

/**
 * The top-left corner to draw a menu at.
 *
 * Opens down and to the right of the point, which is where a pointer expects
 * it, and flips to the other side of the point when there is not room — the
 * flip keeps the pointer on a corner of the menu rather than in the middle of
 * it, so the item under the cursor is never one nobody aimed at.
 *
 * Pinned to the margin when neither side fits, because a menu half off the
 * screen is worse than one that covers the point it came from.
 */
export function menuPosition(
  at: Point,
  size: Size,
  viewport: Size,
  margin = MENU_MARGIN_PX
): Point {
  return {
    x: place(at.x, size.width, viewport.width, margin),
    y: place(at.y, size.height, viewport.height, margin)
  };
}

function place(at: number, extent: number, available: number, margin: number): number {
  // Room the natural way: after the point.
  if (at + extent + margin <= available) return Math.max(margin, at);
  // Room the other way: before it.
  if (at - extent - margin >= 0) return at - extent;
  // Neither: as far along as it will go without leaving the window.
  return Math.max(margin, available - extent - margin);
}
