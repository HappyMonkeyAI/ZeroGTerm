import { describe, expect, it } from 'vitest';
import { askSuggestion, boundedTail, canAutoRun, isConfigured } from '../src/renderer/ai-suggest';

const ai = { requireApproval: false, includeOutput: false };

describe('canAutoRun', () => {
  it('allows a metadata-only suggestion to run when approval is off', () => {
    expect(canAutoRun(ai, false, 'git status')).toBe(true);
  });

  it('refuses when approval is on', () => {
    expect(canAutoRun({ ...ai, requireApproval: true }, false, 'git status')).toBe(false);
  });

  it('refuses whenever terminal output was part of the prompt', () => {
    // The rule the whole feature's safety rests on: the answer is downstream of
    // text a remote host chose, so it has to be seen before it runs.
    expect(canAutoRun(ai, true, 'git status')).toBe(false);
  });

  it('refuses while the output setting is on, even for this request', () => {
    // Belt and braces: the setting and the per-request fact are checked
    // separately, so a mismatch between them cannot open the gap.
    expect(canAutoRun({ ...ai, includeOutput: true }, false, 'git status')).toBe(false);
  });

  it('refuses an empty command, which is what a bad reply produces', () => {
    expect(canAutoRun(ai, false, '')).toBe(false);
    expect(canAutoRun(ai, false, '   ')).toBe(false);
  });
});

describe('isConfigured', () => {
  it('needs both a base URL and a model', () => {
    expect(isConfigured({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3' })).toBe(true);
    expect(isConfigured({ baseUrl: 'http://127.0.0.1:11434/v1', model: '' })).toBe(false);
    expect(isConfigured({ baseUrl: '', model: 'llama3' })).toBe(false);
    expect(isConfigured({ baseUrl: '  ', model: '  ' })).toBe(false);
  });
});

describe('askSuggestion', () => {
  it('starts empty, remembering which pane was asked about', () => {
    expect(askSuggestion('local:api')).toEqual({ phase: 'asking', sessionId: 'local:api', prompt: '' });
  });
});

describe('boundedTail', () => {
  it('returns short text whole', () => {
    expect(boundedTail('one\ntwo', 100)).toBe('one\ntwo');
  });

  it('drops the partial first line rather than handing over half a stack frame', () => {
    const text = 'aaaa\nbbbb\ncccc';
    // A cap of 7 lands inside 'bbbb', so 'bbbb' goes and 'cccc' stays.
    expect(boundedTail(text, 7)).toBe('cccc');
  });

  it('keeps whole lines when the cut is already on a boundary', () => {
    expect(boundedTail('aaaa\nbbbb\ncccc', 9)).toBe('cccc');
  });

  it('truncates rather than discarding a single line longer than the cap', () => {
    // Dropping it would return nothing, which is worse than a partial line.
    const result = boundedTail('x'.repeat(50), 10);
    expect(result).toHaveLength(10);
  });

  it('strips trailing blank lines, which a prompt sitting idle produces', () => {
    expect(boundedTail('done\n\n\n', 100)).toBe('done');
  });

  it('is empty for a zero or negative cap', () => {
    expect(boundedTail('anything', 0)).toBe('');
    expect(boundedTail('anything', -5)).toBe('');
  });

  it('is empty for empty input', () => {
    expect(boundedTail('', 100)).toBe('');
    expect(boundedTail('   \n  ', 100)).toBe('');
  });
});
