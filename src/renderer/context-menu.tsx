// A menu opened by a right-click.
//
// Deliberately not Electron's native menu: the workspace tabs live in the
// renderer, the actions are renderer state, and a native menu would mean an IPC
// round trip in each direction plus a second place where the same list of
// commands is written down. This one is markup like the rest of the interface,
// so it inherits the theme and can be driven by a test.
//
// It closes on anything that means the user has moved on — a press anywhere
// else, Escape, the window losing focus, a scroll — because a menu that
// outlives its moment ends up acting on a workspace that has since changed.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { menuPosition, type Point } from './menu-position';

export type MenuItem = {
  label: string;
  /** Absent for a heading-like row, or one that has nothing to do. */
  onSelect?: () => void;
  icon?: string;
  disabled?: boolean;
  /** Why it is disabled, said rather than left to be guessed at. */
  hint?: string;
  danger?: boolean;
};

export function ContextMenu({
  at,
  items,
  label,
  onClose
}: {
  at: Point;
  items: MenuItem[];
  label: string;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  // Drawn at the point first and moved once measured: the height depends on how
  // many items there are, and a menu cannot know that before it renders.
  const [position, setPosition] = useState<Point>(at);

  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect();
    if (!box) return;
    setPosition(
      menuPosition(at, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight })
    );
  }, [at, items.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Handled here and stopped: the window handler would go looking for an
      // overlay to close instead, and the menu is not one of those.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const dismiss = () => onClose();
    // Capture phase, so the press that dismisses the menu does not also land on
    // whatever is underneath it.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('blur', dismiss);
    window.addEventListener('wheel', dismiss, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('wheel', dismiss);
    };
  }, [onClose]);

  return (
    <div
      className="context-menu"
      role="menu"
      aria-label={label}
      ref={card}
      style={{ left: position.x, top: position.y }}
      // The menu's own presses must not reach the dismissing listener above.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`context-menu-item ${item.danger ? 'danger' : ''}`.trim()}
          disabled={item.disabled || !item.onSelect}
          title={item.hint ?? ''}
          onClick={() => {
            onClose();
            item.onSelect?.();
          }}
        >
          {item.icon ? <Icon name={item.icon} /> : <span className="context-menu-gap" />}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}
