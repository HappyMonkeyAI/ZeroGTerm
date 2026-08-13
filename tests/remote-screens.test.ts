import { describe, expect, it } from 'vitest';
import { looksLikeShellPrompt, normalizeHost } from '../src/renderer/remote-screens';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('normalizeHost', () => {
  it('strips a user prefix', () => {
    expect(normalizeHost('dev@example.com')).toBe('example.com');
    expect(normalizeHost('example.com')).toBe('example.com');
  });

  it('strips a port, so a target typed as user@host:port still matches its connection', () => {
    // SessionInfo.host keeps the whole SSH target and the dialog placeholder is
    // "user@server:22", while KnownConnection.hostName is bare.
    expect(normalizeHost('dev@example.com:2222')).toBe('example.com');
    expect(normalizeHost('example.com:2222')).toBe('example.com');
    expect(normalizeHost('dev@example.com:2222')).toBe(normalizeHost('example.com'));
  });

  it('leaves IPv6 literals intact', () => {
    expect(normalizeHost('::1')).toBe('::1');
    expect(normalizeHost('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('looksLikeShellPrompt', () => {
  it('recognises common prompts', () => {
    expect(looksLikeShellPrompt('user@host:~$ ')).toBe(true);
    expect(looksLikeShellPrompt('root@host:/# ')).toBe(true);
    expect(looksLikeShellPrompt('user@host ~ % ')).toBe(true);
    expect(looksLikeShellPrompt('PS C:\\Users> ')).toBe(true);
  });

  it('sees through colour codes and window-title sequences after the prompt', () => {
    expect(looksLikeShellPrompt(`${ESC}[32muser@host${ESC}[0m:~$ ${ESC}[0m`)).toBe(true);
    expect(looksLikeShellPrompt(`${ESC}]0;user@host${BEL}user@host:~$ `)).toBe(true);
  });

  it('does not fire on ordinary output', () => {
    expect(looksLikeShellPrompt('Last login: Tue Aug 12 09:00:00 2026')).toBe(false);
    expect(looksLikeShellPrompt('Loading modules...')).toBe(false);
    expect(looksLikeShellPrompt('')).toBe(false);
  });

  it('matches a prompt assembled across chunks, which a per-chunk test would miss', () => {
    // A PTY read can end mid-escape-sequence: neither half looks like a prompt
    // on its own, because the colour reset is only strippable once complete.
    const chunks = [`user@host:~$ ${ESC}[0`, 'm'];
    expect(chunks.some((chunk) => looksLikeShellPrompt(chunk))).toBe(false);
    expect(looksLikeShellPrompt(chunks.join(''))).toBe(true);
  });
});
