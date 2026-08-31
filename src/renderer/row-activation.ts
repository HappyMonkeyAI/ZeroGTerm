// Click and double-click on a sidebar row that mean different things — open the
// connect dialog, or connect the host straight into a pane.
//
// The browser reports the pair in that order: two `click`s, then one
// `dblclick`. Acting on the first click immediately breaks the second half of
// the gesture rather than merely pre-empting it: the dialog is a fixed
// full-viewport layer, so the second press lands on its backdrop instead of the
// row. `dblclick` is then dispatched on a common ancestor and never reaches the
// row's handler, and the backdrop dismiss rule closes the dialog the first
// click just opened. Holding the single-click action back until a second click
// could no longer arrive is what makes the pair possible at all.
//
// Kept out of main.tsx so the rule can be unit tested: main.tsx calls
// createRoot at module scope and cannot be imported from a test.

import { useEffect, useRef } from 'react';

/**
 * How long a click waits to find out whether it is half of a double-click.
 *
 * A shade above the roughly 200ms most people leave between the two presses of
 * a deliberate double-click, and short enough that the dialog still reads as
 * opening on the click rather than after it.
 */
export const DOUBLE_CLICK_WINDOW_MS = 250;

/** The two timer functions the rule needs, injectable so tests can drive them. */
export type ActivationTimers = {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const REAL_TIMERS: ActivationTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export type RowActivation = {
  onClick(): void;
  onDoubleClick(): void;
  /** Drop a click that is still waiting, for when the row goes away. */
  cancel(): void;
};

export function createRowActivation(options: {
  onSingleClick: () => void;
  onDoubleClick: () => void;
  windowMs?: number;
  timers?: ActivationTimers;
}): RowActivation {
  const windowMs = options.windowMs ?? DOUBLE_CLICK_WINDOW_MS;
  const timers = options.timers ?? REAL_TIMERS;
  // A click waiting to be ruled a single click.
  let pending: unknown = null;
  // Set while the tail of a handled double-click could still produce clicks.
  let settling: unknown = null;

  const clearPending = () => {
    if (pending === null) return;
    timers.clearTimeout(pending);
    pending = null;
  };

  const startSettling = () => {
    if (settling !== null) timers.clearTimeout(settling);
    settling = timers.setTimeout(() => { settling = null; }, windowMs);
  };

  return {
    onClick() {
      // The third click of a triple-click arrives after the double-click has
      // already been acted on. Treating it as a fresh single click would open
      // the dialog on top of the session that double-click just started, so
      // clicks are swallowed until the gesture has been quiet for a full window.
      if (settling !== null) {
        startSettling();
        return;
      }
      clearPending();
      pending = timers.setTimeout(() => {
        pending = null;
        options.onSingleClick();
      }, windowMs);
    },
    onDoubleClick() {
      clearPending();
      startSettling();
      options.onDoubleClick();
    },
    cancel() {
      clearPending();
      if (settling !== null) {
        timers.clearTimeout(settling);
        settling = null;
      }
    }
  };
}

/**
 * Row activation handlers that survive re-renders.
 *
 * The pending click has to outlive rendering — the sidebar re-renders on every
 * status line change, and a fresh arbiter would forget the click and run
 * neither action. The callbacks are read back through a ref so the handlers,
 * created once, still act on the current render's state.
 */
export function useRowActivation(onSingleClick: () => void, onDoubleClick: () => void): RowActivation {
  const callbacks = useRef({ onSingleClick, onDoubleClick });
  callbacks.current = { onSingleClick, onDoubleClick };
  const activation = useRef<RowActivation | null>(null);
  if (!activation.current) {
    activation.current = createRowActivation({
      onSingleClick: () => callbacks.current.onSingleClick(),
      onDoubleClick: () => callbacks.current.onDoubleClick()
    });
  }
  const current = activation.current;
  // A row unmounted mid-window (the sidebar tab changed, the list reloaded)
  // must not fire its action into a UI that has moved on.
  useEffect(() => () => current.cancel(), [current]);
  return current;
}
