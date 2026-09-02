import { describe, expect, it } from 'vitest';
import { MENU_MARGIN_PX, menuPosition } from '../src/renderer/menu-position';

const viewport = { width: 1000, height: 700 };
const size = { width: 200, height: 160 };

describe('menuPosition', () => {
  it('opens down and to the right of the point', () => {
    // Where a pointer expects a menu to appear.
    expect(menuPosition({ x: 100, y: 100 }, size, viewport)).toEqual({ x: 100, y: 100 });
  });

  it('flips to the other side when there is no room', () => {
    // The flip keeps the pointer on a corner of the menu rather than in the
    // middle of it, so the item under the cursor is never one nobody aimed at.
    expect(menuPosition({ x: 950, y: 100 }, size, viewport)).toEqual({ x: 750, y: 100 });
    expect(menuPosition({ x: 100, y: 650 }, size, viewport)).toEqual({ x: 100, y: 490 });
    expect(menuPosition({ x: 950, y: 650 }, size, viewport)).toEqual({ x: 750, y: 490 });
  });

  it('pins a menu that fits on neither side', () => {
    // A menu taller than the window: covering the point it came from is better
    // than hanging half off the screen.
    const tall = { width: 200, height: 900 };
    expect(menuPosition({ x: 100, y: 300 }, tall, viewport).y).toBe(MENU_MARGIN_PX);
    const wide = { width: 1200, height: 100 };
    expect(menuPosition({ x: 100, y: 100 }, wide, viewport).x).toBe(MENU_MARGIN_PX);
  });

  it('keeps a menu off the very edge', () => {
    expect(menuPosition({ x: 0, y: 0 }, size, viewport)).toEqual({ x: MENU_MARGIN_PX, y: MENU_MARGIN_PX });
  });

  it('takes the margin as an argument', () => {
    expect(menuPosition({ x: 0, y: 0 }, size, viewport, 20)).toEqual({ x: 20, y: 20 });
  });

  it('decides each axis on its own', () => {
    // A menu near the right edge but with plenty of room below flips only
    // sideways.
    const at = menuPosition({ x: 950, y: 50 }, size, viewport);
    expect(at.x).toBe(750);
    expect(at.y).toBe(50);
  });
});
