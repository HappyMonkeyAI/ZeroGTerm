import { describe, expect, it, vi } from 'vitest';
import { DOUBLE_CLICK_WINDOW_MS, createRowActivation, type ActivationTimers } from '../src/renderer/row-activation';

// A hand-driven clock: the rule only ever schedules with the same window, so a
// list of live callbacks with an "advance past the window" step is enough, and
// the tests stay free of real waiting.
function fakeTimers() {
  const live = new Map<number, () => void>();
  let next = 1;
  const timers: ActivationTimers = {
    setTimeout(handler) {
      const handle = next++;
      live.set(handle, handler);
      return handle;
    },
    clearTimeout(handle) {
      live.delete(handle as number);
    }
  };
  return {
    timers,
    /** Run everything still scheduled, as the window elapsing would. */
    advance() {
      const due = [...live.entries()];
      live.clear();
      for (const [, handler] of due) handler();
    },
    pending: () => live.size
  };
}

function activation(overrides: { windowMs?: number } = {}) {
  const onSingleClick = vi.fn();
  const onDoubleClick = vi.fn();
  const clock = fakeTimers();
  const handlers = createRowActivation({ onSingleClick, onDoubleClick, timers: clock.timers, ...overrides });
  return { handlers, onSingleClick, onDoubleClick, clock };
}

describe('createRowActivation', () => {
  it('runs the single-click action once the window passes', () => {
    const { handlers, onSingleClick, onDoubleClick, clock } = activation();

    handlers.onClick();
    expect(onSingleClick).not.toHaveBeenCalled();

    clock.advance();
    expect(onSingleClick).toHaveBeenCalledTimes(1);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('runs only the double-click action for a real double-click', () => {
    // The browser order: two clicks, then the dblclick.
    const { handlers, onSingleClick, onDoubleClick, clock } = activation();

    handlers.onClick();
    handlers.onClick();
    handlers.onDoubleClick();

    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    clock.advance();
    expect(onSingleClick).not.toHaveBeenCalled();
  });

  it('does not open the dialog on top of the pane a triple-click started', () => {
    // A third click lands after the double has been acted on. Ruling it a
    // single click would open the connect dialog over the new session.
    const { handlers, onSingleClick, onDoubleClick, clock } = activation();

    handlers.onClick();
    handlers.onClick();
    handlers.onDoubleClick();
    handlers.onClick();

    clock.advance();
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    expect(onSingleClick).not.toHaveBeenCalled();
  });

  it('accepts a single click again once the gesture goes quiet', () => {
    const { handlers, onSingleClick, onDoubleClick, clock } = activation();

    handlers.onClick();
    handlers.onDoubleClick();
    clock.advance();

    handlers.onClick();
    clock.advance();
    expect(onSingleClick).toHaveBeenCalledTimes(1);
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst of clicks into one deferred action', () => {
    const { handlers, onSingleClick, clock } = activation();

    handlers.onClick();
    handlers.onClick();
    handlers.onClick();

    clock.advance();
    expect(onSingleClick).toHaveBeenCalledTimes(1);
  });

  it('drops a waiting click when the row goes away', () => {
    const { handlers, onSingleClick, clock } = activation();

    handlers.onClick();
    handlers.cancel();

    clock.advance();
    expect(onSingleClick).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });

  it('schedules against the double-click window by default', () => {
    const scheduled: number[] = [];
    const onSingleClick = vi.fn();
    const handlers = createRowActivation({
      onSingleClick,
      onDoubleClick: vi.fn(),
      timers: {
        setTimeout(_handler, ms) { scheduled.push(ms); return scheduled.length; },
        clearTimeout() {}
      }
    });

    handlers.onClick();
    expect(scheduled).toEqual([DOUBLE_CLICK_WINDOW_MS]);
  });
});
