// Which custom buttons a pane shows, and what they say.
//
// Kept apart from the pane so the rule — a slot with no command has no button —
// is written down once and can be tested without rendering one.

import type { CustomButton } from './settings';

export type PaneButton = {
  /** The slot, 0–9: what the button shows and what keeps its place when others are empty. */
  slot: number;
  label: string;
  /** Trimmed, and never empty. */
  command: string;
};

/** The buttons to draw, in slot order. A slot keeps its number when earlier ones are unset. */
export function configuredButtons(buttons: readonly CustomButton[]): PaneButton[] {
  const shown: PaneButton[] = [];
  buttons.forEach((button, slot) => {
    const command = button.command.trim();
    if (command) shown.push({ slot, label: button.label.trim(), command });
  });
  return shown;
}

/** What the button is called to assistive technology: its label, or its number when it has none. */
export function buttonName(button: PaneButton): string {
  return button.label || `Button ${button.slot}`;
}

/** The tooltip: the label when there is one, always with what will be sent. */
export function buttonTitle(button: PaneButton): string {
  const action = `Send "${button.command}" and press Enter`;
  return button.label ? `${button.label} — ${action}` : action;
}
