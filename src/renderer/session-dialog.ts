// The new-session dialog's tabs and wording.
//
// Local and SSH are two ways to do one thing — start a session in this
// workspace — so they are two tabs of one dialog rather than two dialogs
// reached from different buttons. Keeping the tab list and the per-kind wording
// in a table here means main.tsx stops carrying nested ternaries for the
// eyebrow, heading and submit label, and the keyboard behaviour can be tested
// without rendering anything.

/** The kinds of session the dialog can create. Workspace is not one of them. */
export type SessionDialogKind = 'local' | 'ssh';

/** Everything the dialog can be: the two session tabs, a workspace, or a port. */
export type DialogKind = SessionDialogKind | 'workspace' | 'forward';

export const SESSION_TABS: Array<{ kind: SessionDialogKind; label: string; hint: string }> = [
  { kind: 'local', label: 'Local terminal', hint: 'Shell on this machine' },
  { kind: 'ssh', label: 'SSH', hint: 'Remote host' }
];

export function isSessionDialogKind(kind: unknown): kind is SessionDialogKind {
  return kind === 'local' || kind === 'ssh';
}

const DIALOG_COPY: Record<DialogKind, { eyebrow: string; title: string; submit: string }> = {
  workspace: { eyebrow: 'WORKSPACE', title: 'New workspace', submit: 'Create workspace' },
  local: { eyebrow: 'NEW SESSION', title: 'Start a session', submit: 'Open terminal' },
  ssh: { eyebrow: 'NEW SESSION', title: 'Start a session', submit: 'Connect' },
  forward: { eyebrow: 'SHARED PORT', title: 'Share a port', submit: 'Share port' }
};

export function dialogCopy(kind: DialogKind): { eyebrow: string; title: string; submit: string } {
  return DIALOG_COPY[kind];
}

/**
 * Which tab a key press moves to, or null when the key is not navigation.
 *
 * A tablist is a single tab stop: Tab moves out of it, and the arrows move
 * between the tabs, wrapping at both ends. Home and End jump to the edges.
 * Without this the tabs would each take a tab stop and the dialog's fields
 * would sit several presses away from the heading.
 */
export function nextSessionTab(current: SessionDialogKind, key: string): SessionDialogKind | null {
  const index = SESSION_TABS.findIndex((tab) => tab.kind === current);
  if (index === -1) return null;
  const size = SESSION_TABS.length;

  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return SESSION_TABS[(index + 1) % size].kind;
    case 'ArrowLeft':
    case 'ArrowUp':
      return SESSION_TABS[(index - 1 + size) % size].kind;
    case 'Home':
      return SESSION_TABS[0].kind;
    case 'End':
      return SESSION_TABS[size - 1].kind;
    default:
      return null;
  }
}
