// The list of starred directories, opened from the star beside the path line.
//
// Not the shared ContextMenu: each row here has two actions — jump, and remove —
// and a favourite on another machine has to be removable without first going
// there. It closes the same way a context menu does, on anything that means the
// user has moved on.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FavouriteDirectory } from '../shared/types';
import { Icon } from './icons';
import { menuPosition, type Point } from './menu-position';
import { placeLabel } from './favourites';

export function FavouritesMenu({
  at,
  here,
  elsewhere,
  canJump,
  onJump,
  onRemove,
  onClose
}: {
  at: Point;
  /** Favourites the focused pane can `cd` to. */
  here: FavouriteDirectory[];
  /** Favourites on other machines, or in a path style this pane cannot use. */
  elsewhere: FavouriteDirectory[];
  /** Whether a favourite from `elsewhere` can be opened, and if not, why. */
  canJump: (favourite: FavouriteDirectory) => string | null;
  onJump: (favourite: FavouriteDirectory) => void;
  onRemove: (favourite: FavouriteDirectory) => void;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Point>(at);
  const count = here.length + elsewhere.length;

  useLayoutEffect(() => {
    const box = card.current?.getBoundingClientRect();
    if (!box) return;
    setPosition(menuPosition(at, { width: box.width, height: box.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [at, count]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const dismiss = () => onClose();
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && card.current?.contains(event.target)) return;
      // The button that opened the menu toggles it itself; closing here as well
      // would let its click open the menu straight back up.
      if (event.target instanceof Element && event.target.closest('[data-favourites-toggle]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', dismissOutside, true);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', dismissOutside, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [onClose]);

  const row = (favourite: FavouriteDirectory, showPlace: boolean) => {
    const blocked = showPlace ? canJump(favourite) : null;
    return (
      <div className="favourite-row" key={favourite.id} role="none">
        <button
          type="button"
          role="menuitem"
          className="favourite-jump"
          disabled={Boolean(blocked)}
          title={blocked ?? (showPlace ? `Open a new pane in ${favourite.path}` : `Take the shell to ${favourite.path}`)}
          onClick={() => {
            onClose();
            onJump(favourite);
          }}
        >
          <Icon name="folder" />
          <span className="favourite-text">
            <b>{favourite.label ?? favourite.path}</b>
            {showPlace ? <small>{placeLabel(favourite)}</small> : null}
          </span>
        </button>
        <button
          type="button"
          className="favourite-remove"
          title={`Remove ${favourite.path} from favourites`}
          aria-label={`Remove ${favourite.path} from favourites`}
          onClick={() => onRemove(favourite)}
        >
          <Icon name="x" />
        </button>
      </div>
    );
  };

  return (
    <div className="context-menu favourites-menu" role="menu" aria-label="Favourite directories" ref={card} style={{ left: position.x, top: position.y }}>
      {!count ? (
        <p className="favourites-empty">No favourites yet. Click the star beside the path, or in a directory browser, to add the folder you are in.</p>
      ) : null}
      {here.length ? <div className="favourites-heading">This pane</div> : null}
      {here.map((favourite) => row(favourite, false))}
      {elsewhere.length ? <div className="favourites-heading">Elsewhere — opens a new pane</div> : null}
      {elsewhere.map((favourite) => row(favourite, true))}
    </div>
  );
}
