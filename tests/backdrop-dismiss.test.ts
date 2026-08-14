import { describe, expect, it, vi } from 'vitest';
import { createBackdropDismiss } from '../src/renderer/backdrop-dismiss';

// Stand-ins for the DOM nodes involved: the backdrop the handlers are on, the
// dialog inside it, and the name field the user drag-selects.
const backdrop = { id: 'backdrop' };
const dialog = { id: 'dialog' };
const nameField = { id: 'name-field' };

describe('createBackdropDismiss', () => {
  it('dismisses when the backdrop itself is clicked', () => {
    const dismiss = vi.fn();
    const handlers = createBackdropDismiss(dismiss);

    handlers.onMouseDown({ target: backdrop, currentTarget: backdrop });
    handlers.onClick({ target: backdrop, currentTarget: backdrop });

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('stays open when text is drag-selected out of a field', () => {
    // The press lands in the name field and the release lands outside it, so
    // the browser dispatches the click on their common ancestor — the
    // backdrop. Closing on that is the bug: the dialog vanished mid-selection.
    const dismiss = vi.fn();
    const handlers = createBackdropDismiss(dismiss);

    handlers.onMouseDown({ target: nameField, currentTarget: backdrop });
    handlers.onClick({ target: backdrop, currentTarget: backdrop });

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('ignores clicks that merely bubble up from inside the dialog', () => {
    const dismiss = vi.fn();
    const handlers = createBackdropDismiss(dismiss);

    handlers.onMouseDown({ target: dialog, currentTarget: backdrop });
    handlers.onClick({ target: dialog, currentTarget: backdrop });

    expect(dismiss).not.toHaveBeenCalled();
  });

  it('still dismisses on the next backdrop click after a drag-select', () => {
    const dismiss = vi.fn();
    const handlers = createBackdropDismiss(dismiss);

    handlers.onMouseDown({ target: nameField, currentTarget: backdrop });
    handlers.onClick({ target: backdrop, currentTarget: backdrop });
    handlers.onMouseDown({ target: backdrop, currentTarget: backdrop });
    handlers.onClick({ target: backdrop, currentTarget: backdrop });

    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('needs a fresh press for each dismissal', () => {
    const dismiss = vi.fn();
    const handlers = createBackdropDismiss(dismiss);

    handlers.onMouseDown({ target: backdrop, currentTarget: backdrop });
    handlers.onClick({ target: backdrop, currentTarget: backdrop });
    handlers.onClick({ target: backdrop, currentTarget: backdrop });

    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});
