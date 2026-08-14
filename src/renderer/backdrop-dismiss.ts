// Click-the-backdrop-to-dismiss for the overlays (modals, approval, history,
// overview). Kept out of main.tsx so the rule can be unit tested: main.tsx
// calls createRoot at module scope and cannot be imported from a test.

import { useRef } from 'react';

/** The only two fields of a mouse event the rule looks at. */
export type BackdropMouseEvent = {
  target: unknown;
  currentTarget: unknown;
};

export type BackdropDismissHandlers = {
  onMouseDown(event: BackdropMouseEvent): void;
  onClick(event: BackdropMouseEvent): void;
};

/**
 * Dismiss only when the gesture *started* on the backdrop.
 *
 * A click event is dispatched on the nearest common ancestor of the mousedown
 * and mouseup targets, not on the element pressed. Drag-selecting the text in
 * a dialog's name field and releasing a few pixels outside that field
 * therefore produces a click whose target is the backdrop itself — so a
 * backdrop handler that closes on any click closes the dialog mid-selection,
 * and a slower drag that happens to end inside the field survives. That is the
 * "modal closes while I select the name" bug.
 *
 * Requiring the press to have landed on the backdrop makes dismissal depend on
 * where the user started, which is what they are actually expressing. It also
 * removes the need for the dialog itself to stop propagation: a click bubbling
 * up from inside never has the backdrop as its target.
 */
export function createBackdropDismiss(dismiss: () => void): BackdropDismissHandlers {
  let pressedBackdrop = false;
  return {
    onMouseDown(event) {
      pressedBackdrop = event.target === event.currentTarget;
    },
    onClick(event) {
      const dismissable = pressedBackdrop && event.target === event.currentTarget;
      // One press, one decision: a stale flag must not dismiss a later click.
      pressedBackdrop = false;
      if (dismissable) dismiss();
    }
  };
}

/**
 * Backdrop handlers that survive re-renders.
 *
 * The press flag has to outlive rendering — a render between mousedown and
 * click (a status update, say) would otherwise forget where the gesture
 * started and dismiss the dialog anyway.
 */
export function useBackdropDismiss(dismiss: () => void): BackdropDismissHandlers {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  const handlers = useRef<BackdropDismissHandlers | null>(null);
  if (!handlers.current) handlers.current = createBackdropDismiss(() => dismissRef.current());
  return handlers.current;
}
