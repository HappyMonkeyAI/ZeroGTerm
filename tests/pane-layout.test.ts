import { describe, expect, it } from 'vitest';
import {
  defaultRatiosFor,
  isSplitAdjusted,
  singlePaneAction,
  singlePaneTitle,
  splitAxes,
  splitButtonAction,
  splitButtonTitle,
  type PaneView
} from '../src/renderer/pane-layout';

const view = (patch: Partial<PaneView> = {}): PaneView => ({
  layout: 'split-v',
  maximized: false,
  columnRatio: 0.5,
  rowRatio: 0.5,
  sessionCount: 2,
  lastSplit: 'split-v',
  ...patch
});

describe('which dividers a layout has', () => {
  it('gives each split only the axes it draws', () => {
    expect(splitAxes('split-v')).toEqual(['column']);
    expect(splitAxes('split-h')).toEqual(['row']);
    expect(splitAxes('grid')).toEqual(['column', 'row']);
  });

  it('gives the single-pane view none, because it has nothing to resize', () => {
    expect(splitAxes('stack')).toEqual([]);
  });
});

describe('whether panes have been resized', () => {
  it('reads an untouched split as untouched', () => {
    expect(isSplitAdjusted('split-v', { columnRatio: 0.5, rowRatio: 0.5 })).toBe(false);
  });

  it('ignores the axis the layout does not show', () => {
    // A vertical split has no row divider, so a stored row ratio from some
    // other layout must not make it look adjusted.
    expect(isSplitAdjusted('split-v', { columnRatio: 0.5, rowRatio: 0.8 })).toBe(false);
    expect(isSplitAdjusted('grid', { columnRatio: 0.5, rowRatio: 0.8 })).toBe(true);
  });

  it('sees a drag that landed a hair off centre', () => {
    expect(isSplitAdjusted('split-v', { columnRatio: 0.5001, rowRatio: 0.5 })).toBe(false);
    expect(isSplitAdjusted('split-v', { columnRatio: 0.52, rowRatio: 0.5 })).toBe(true);
  });
});

describe('what the defaults reset', () => {
  it('resets only the axes on screen', () => {
    expect(defaultRatiosFor('split-v')).toEqual({ splitColumnRatio: 0.5 });
    expect(defaultRatiosFor('split-h')).toEqual({ splitRowRatio: 0.5 });
    expect(defaultRatiosFor('grid')).toEqual({ splitColumnRatio: 0.5, splitRowRatio: 0.5 });
  });
});

describe('clicking a layout button', () => {
  it('shows the layout when it is not the one on screen', () => {
    expect(splitButtonAction('grid', view({ layout: 'split-v' }))).toEqual({ kind: 'show', layout: 'grid' });
  });

  it('leaves a maximized pane for the split, rather than folding further', () => {
    expect(splitButtonAction('split-v', view({ layout: 'split-v', maximized: true })))
      .toEqual({ kind: 'show', layout: 'split-v' });
  });

  it('evens the panes up on the second click when they have been dragged', () => {
    expect(splitButtonAction('split-v', view({ columnRatio: 0.7 })))
      .toEqual({ kind: 'reset-splits', ratios: { splitColumnRatio: 0.5 } });
  });

  it('folds to a single pane on the second click once the panes are already even', () => {
    expect(splitButtonAction('split-v', view())).toEqual({ kind: 'maximize' });
  });

  it('resets before it folds, so neither step is skipped past', () => {
    const dragged = view({ columnRatio: 0.7 });
    expect(splitButtonAction('split-v', dragged).kind).toBe('reset-splits');
    // The reset is what the next click sees, and only then does it fold.
    expect(splitButtonAction('split-v', { ...dragged, columnRatio: 0.5 }).kind).toBe('maximize');
  });
});

describe('the single-pane button', () => {
  it('restores a maximized pane', () => {
    expect(singlePaneAction(view({ maximized: true }))).toEqual({ kind: 'restore' });
  });

  it('maximizes the focused pane when there is more than one terminal', () => {
    expect(singlePaneAction(view({ sessionCount: 2 }))).toEqual({ kind: 'maximize' });
  });

  it('falls back to the stack layout when there is nothing to maximize over', () => {
    expect(singlePaneAction(view({ sessionCount: 1 }))).toEqual({ kind: 'show', layout: 'stack' });
  });

  it('folds back out to the split that was on screen, not a fixed one', () => {
    expect(singlePaneAction(view({ layout: 'stack', lastSplit: 'grid' })))
      .toEqual({ kind: 'show', layout: 'grid' });
    expect(singlePaneAction(view({ layout: 'stack', lastSplit: 'split-h' })))
      .toEqual({ kind: 'show', layout: 'split-h' });
  });
});

describe('what the buttons say they will do', () => {
  it('names the layout a button would switch to', () => {
    expect(splitButtonTitle('grid', view({ layout: 'split-v' }))).toBe('Four-pane grid');
  });

  it('offers the reset before the fold', () => {
    expect(splitButtonTitle('split-v', view({ columnRatio: 0.7 }))).toBe('Reset pane sizes');
    expect(splitButtonTitle('split-v', view())).toBe('Maximize focused pane');
    expect(splitButtonTitle('split-v', view({ sessionCount: 1 }))).toBe('Single pane');
  });

  it('names the split the single-pane view will return to', () => {
    expect(singlePaneTitle(view({ maximized: true, lastSplit: 'grid' }))).toBe('Back to four-pane grid (Ctrl+Shift+L)');
    expect(singlePaneTitle(view({ layout: 'stack', lastSplit: 'split-h' }))).toBe('Back to horizontal split (Ctrl+Shift+L)');
  });

  it('says what it will do on the way in, too', () => {
    expect(singlePaneTitle(view({ sessionCount: 2 }))).toBe('Maximize focused pane (Ctrl+Shift+L)');
    expect(singlePaneTitle(view({ sessionCount: 1 }))).toBe('Single pane (Ctrl+Shift+L)');
  });

  it('names the shortcut in every case, since this button is the only place it appears', () => {
    // The keyboard equivalent for the layout toggle was documented nowhere at
    // all — not in a tooltip, not in the README — so it is pinned here.
    const cases = [
      view(),
      view({ maximized: true }),
      view({ layout: 'stack' }),
      view({ sessionCount: 1 }),
      view({ sessionCount: 4, layout: 'grid' })
    ];
    for (const candidate of cases) {
      expect(singlePaneTitle(candidate)).toContain('Ctrl+Shift+L');
    }
  });
});
