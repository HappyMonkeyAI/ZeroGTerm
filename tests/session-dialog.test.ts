import { describe, expect, it } from 'vitest';
import {
  SESSION_TABS,
  dialogCopy,
  isSessionDialogKind,
  nextSessionTab
} from '../src/renderer/session-dialog';

describe('SESSION_TABS', () => {
  it('offers local first, then SSH, each with a distinct kind', () => {
    expect(SESSION_TABS.map((tab) => tab.kind)).toEqual(['local', 'ssh']);
    for (const tab of SESSION_TABS) {
      expect(tab.label).toBeTruthy();
      expect(tab.hint).toBeTruthy();
    }
  });
});

describe('isSessionDialogKind', () => {
  it('separates the session tabs from the workspace dialog', () => {
    expect(isSessionDialogKind('local')).toBe(true);
    expect(isSessionDialogKind('ssh')).toBe(true);
    // A new workspace is not a session, so it gets no tab strip.
    expect(isSessionDialogKind('workspace')).toBe(false);
    expect(isSessionDialogKind(null)).toBe(false);
    expect(isSessionDialogKind(undefined)).toBe(false);
  });
});

describe('dialogCopy', () => {
  it('gives the session tabs one shared heading and their own submit label', () => {
    // The heading names the dialog, not the tab: the tab strip already says which.
    expect(dialogCopy('local').title).toBe(dialogCopy('ssh').title);
    expect(dialogCopy('local').eyebrow).toBe(dialogCopy('ssh').eyebrow);
    expect(dialogCopy('local').submit).toBe('Open terminal');
    expect(dialogCopy('ssh').submit).toBe('Connect');
  });

  it('keeps the workspace dialog worded as itself', () => {
    expect(dialogCopy('workspace').title).toBe('New workspace');
    expect(dialogCopy('workspace').submit).toBe('Create workspace');
  });
});

describe('nextSessionTab', () => {
  it('moves with the arrow keys, wrapping at both ends', () => {
    expect(nextSessionTab('local', 'ArrowRight')).toBe('ssh');
    expect(nextSessionTab('ssh', 'ArrowRight')).toBe('local');
    expect(nextSessionTab('ssh', 'ArrowLeft')).toBe('local');
    expect(nextSessionTab('local', 'ArrowLeft')).toBe('ssh');
  });

  it('treats vertical arrows the same, since the tabs may wrap on a narrow window', () => {
    expect(nextSessionTab('local', 'ArrowDown')).toBe('ssh');
    expect(nextSessionTab('ssh', 'ArrowUp')).toBe('local');
  });

  it('jumps to the edges on Home and End', () => {
    expect(nextSessionTab('ssh', 'Home')).toBe('local');
    expect(nextSessionTab('local', 'End')).toBe('ssh');
  });

  it('ignores keys that are not navigation, so typing still reaches the fields', () => {
    for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'ArrowRightExtra']) {
      expect(nextSessionTab('local', key)).toBeNull();
    }
  });
});
