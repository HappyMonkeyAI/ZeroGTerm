import { describe, expect, it } from 'vitest';
import { classifyMcpPrompt } from '../src/main/prompt-classifier';

describe('MCP prompt classifier', () => {
  it.each([
    ['Password: ', 'password'],
    ['Enter passphrase for key', 'passphrase'],
    ['Enter verification code', 'verification-code'],
    ['The authenticity of host cannot be established. Are you sure you want to continue connecting?', 'host-key'],
    ['Continue?', 'unknown']
  ])('classifies %s', (text, kind) => {
    expect(classifyMcpPrompt(text)).toMatchObject({ kind, answerableByMcp: false });
  });

  it('strips ANSI/control data and bounds prompt text', () => {
    const result = classifyMcpPrompt('\u001b[31mPassword:\u001b[0m ' + 'x'.repeat(1000));
    expect(result.kind).toBe('password');
    expect(result.text.length).toBeLessThanOrEqual(512);
    expect(result.text).not.toContain('\u001b');
  });
});
