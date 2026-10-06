import { describe, expect, it } from 'vitest';
import { buttonName, buttonTitle, configuredButtons } from '../src/renderer/pane-buttons';
import { emptyCustomButtons } from '../src/renderer/settings';

describe('configuredButtons', () => {
  it('shows nothing when no slot has a command', () => {
    expect(configuredButtons(emptyCustomButtons())).toEqual([]);
  });

  it('keeps a slot its own number when earlier ones are unset', () => {
    const buttons = emptyCustomButtons();
    buttons[4] = { label: 'deploy', command: 'npm run deploy' };
    buttons[9] = { label: '', command: 'exit' };
    expect(configuredButtons(buttons)).toEqual([
      { slot: 4, label: 'deploy', command: 'npm run deploy' },
      { slot: 9, label: '', command: 'exit' }
    ]);
  });

  it('hides a slot whose command is only spaces, but keeps its label out of play', () => {
    const buttons = emptyCustomButtons();
    buttons[0] = { label: 'x', command: '   ' };
    expect(configuredButtons(buttons)).toEqual([]);
  });

  it('trims what it will send', () => {
    const buttons = emptyCustomButtons();
    buttons[1] = { label: ' tidy ', command: '  ls -la  ' };
    expect(configuredButtons(buttons)[0]).toEqual({ slot: 1, label: 'tidy', command: 'ls -la' });
  });
});

describe('buttonName', () => {
  it('is the label, or the number when there is none', () => {
    expect(buttonName({ slot: 3, label: 'status', command: 'git status' })).toBe('status');
    expect(buttonName({ slot: 3, label: '', command: 'git status' })).toBe('Button 3');
  });
});

describe('buttonTitle', () => {
  it('says what will be sent, with the label when there is one', () => {
    expect(buttonTitle({ slot: 2, label: 'status', command: 'git status' })).toBe('status — Send "git status" and press Enter');
    expect(buttonTitle({ slot: 2, label: '', command: 'git status' })).toBe('Send "git status" and press Enter');
  });
});
