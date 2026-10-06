// Which panes a two-pane split shows when the workspace holds more than two.
//
// The split has two slots and the workspace can have up to four panes, so the
// rest are mounted but hidden. The user picks who sits in each slot; this keeps
// that pick pure so the rules — a pick naming a pane that has gone, the cycle
// skipping the pane in the other slot — can be tested away from the grid.

/** How many panes a two-way split shows at once. */
export const SPLIT_SLOTS = 2;

/**
 * The panes to show, in slot order.
 *
 * `preferred` is what the user last chose, and may be stale: a pane closed, one
 * not reconnected yet, a file edited by hand. What still exists is kept in its
 * in the order it was chosen; the remaining slots are filled from the workspace
 * order, so a split is never short of panes it could have shown.
 */
export function resolveVisible(ids: readonly string[], preferred: readonly string[] | undefined, slots = SPLIT_SLOTS): string[] {
  const present = new Set(ids);
  const chosen: string[] = [];
  for (const id of preferred ?? []) {
    if (chosen.length >= slots) break;
    if (present.has(id) && !chosen.includes(id)) chosen.push(id);
  }
  for (const id of ids) {
    if (chosen.length >= slots) break;
    if (!chosen.includes(id)) chosen.push(id);
  }
  return chosen;
}

/** Whether there is any hidden pane to bring in, which is when arrows are worth showing. */
export function canCycle(ids: readonly string[], slots = SPLIT_SLOTS): boolean {
  return ids.length > slots;
}

/**
 * The visible panes after a slot's arrow is pressed.
 *
 * The slot steps through every pane the *other* slot is not showing, in
 * workspace order and wrapping round, so each pane gets a turn and the two slots
 * can never show the same one. Returns the list unchanged when there is nothing
 * to step to.
 */
export function cycleSlot(ids: readonly string[], visible: readonly string[], slot: number, direction: -1 | 1): string[] {
  const current = visible[slot];
  if (current === undefined || !ids.includes(current)) return [...visible];
  const others = visible.filter((_, index) => index !== slot);
  const candidates = ids.filter((id) => !others.includes(id));
  if (candidates.length < 2) return [...visible];
  const at = candidates.indexOf(current);
  const next = candidates[(at + direction + candidates.length) % candidates.length];
  return visible.map((id, index) => (index === slot ? next : id));
}
