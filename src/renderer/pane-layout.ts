// What the layout buttons do to the pane grid, kept pure so the rules can be
// unit tested away from React. The buttons are the only place three separate
// ideas meet -- which split is on screen, whether its panes have been dragged,
// and whether one pane is filling the workspace -- and that meeting is where
// the surprises live.

import { DEFAULT_SETTINGS, type Layout } from './settings';

/**
 * The layouts with dividers. 'stack' is the single-pane view they fold into, so
 * it is never somewhere the single-pane button can return you to.
 */
export type SplitLayout = Exclude<Layout, 'stack'>;

/** The names the buttons carry, so a tooltip and a heading cannot disagree. */
export const LAYOUT_NAMES: Record<SplitLayout, string> = {
  'split-v': 'Vertical split',
  'split-h': 'Horizontal split',
  grid: 'Four-pane grid'
};

/** The split buttons in the order they sit in the bar. */
export const SPLIT_BUTTONS: { layout: SplitLayout; icon: string }[] = [
  { layout: 'split-v', icon: 'split-v' },
  { layout: 'split-h', icon: 'split-h' },
  { layout: 'grid', icon: 'grid' }
];

/** Everything a layout button needs to know about the grid it is acting on. */
export type PaneView = {
  layout: Layout;
  /** Whether a single pane is currently filling the workspace. */
  maximized: boolean;
  columnRatio: number;
  rowRatio: number;
  sessionCount: number;
  /** The split the single-pane view folds back out to. */
  lastSplit: SplitLayout;
};

export type SplitRatios = { splitColumnRatio?: number; splitRowRatio?: number };

/**
 * What a click should do. Returned rather than performed so the rules can be
 * asserted on directly, and so the component stays the only thing holding state.
 */
export type PaneAction =
  | { kind: 'show'; layout: Layout }
  | { kind: 'reset-splits'; ratios: SplitRatios }
  | { kind: 'maximize' }
  | { kind: 'restore' };

/** The dividers a layout actually puts on screen. */
export function splitAxes(layout: Layout): ('column' | 'row')[] {
  if (layout === 'split-v') return ['column'];
  if (layout === 'split-h') return ['row'];
  if (layout === 'grid') return ['column', 'row'];
  return [];
}

/**
 * Whether the panes of a layout are sitting at sizes the user chose.
 *
 * Compared with a tolerance because a dragged ratio is a float that will never
 * land exactly on the default -- but a tolerance narrower than the 0.02 a
 * keyboard nudge moves, so a nudged split still counts as adjusted.
 */
export function isSplitAdjusted(target: Layout, view: Pick<PaneView, 'columnRatio' | 'rowRatio'>): boolean {
  return splitAxes(target).some((axis) => {
    const current = axis === 'column' ? view.columnRatio : view.rowRatio;
    const base = axis === 'column'
      ? DEFAULT_SETTINGS.sessions.splitColumnRatio
      : DEFAULT_SETTINGS.sessions.splitRowRatio;
    return Math.abs(current - base) > 0.005;
  });
}

/**
 * The default sizes for the axes a layout shows, and only those: evening up a
 * divider the user cannot see would change a split they are not looking at.
 */
export function defaultRatiosFor(target: Layout): SplitRatios {
  const axes = splitAxes(target);
  return {
    ...(axes.includes('column') ? { splitColumnRatio: DEFAULT_SETTINGS.sessions.splitColumnRatio } : {}),
    ...(axes.includes('row') ? { splitRowRatio: DEFAULT_SETTINGS.sessions.splitRowRatio } : {})
  };
}

/**
 * The single-pane view has two shapes: a pane maximized over a split when there
 * is more than one terminal, and the stack layout when there is not. Both fold
 * back out to the split that was on screen, so the trip is a round one however
 * it was made.
 */
export function singlePaneAction(view: PaneView): PaneAction {
  if (view.maximized) return { kind: 'restore' };
  if (view.layout === 'stack') return { kind: 'show', layout: view.lastSplit };
  return view.sessionCount > 1 ? { kind: 'maximize' } : { kind: 'show', layout: 'stack' };
}

/**
 * A layout button is three things in order: show this layout, then even up
 * panes the user has dragged, then fold to a single pane. Each click does the
 * first of those still worth doing, so no step is skipped past -- and a layout
 * that is already on screen at its default sizes is the only one that folds.
 */
export function splitButtonAction(target: SplitLayout, view: PaneView): PaneAction {
  if (view.layout !== target || view.maximized) return { kind: 'show', layout: target };
  if (isSplitAdjusted(target, view)) return { kind: 'reset-splits', ratios: defaultRatiosFor(target) };
  return singlePaneAction(view);
}

/** The tooltip for a split button, so it cannot describe a click it will not make. */
export function splitButtonTitle(target: SplitLayout, view: PaneView): string {
  if (view.layout !== target || view.maximized) return LAYOUT_NAMES[target];
  if (isSplitAdjusted(target, view)) return 'Reset pane sizes';
  return view.sessionCount > 1 ? 'Maximize focused pane' : 'Single pane';
}

/** The tooltip for the single-pane button, which names the split it goes back to. */
export function singlePaneTitle(view: PaneView): string {
  if (view.maximized || view.layout === 'stack') return `Back to ${LAYOUT_NAMES[view.lastSplit].toLowerCase()}`;
  return view.sessionCount > 1 ? 'Maximize focused pane' : 'Single pane';
}
