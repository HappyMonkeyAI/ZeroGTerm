import { describe, expect, it } from 'vitest';
import { decideExternalLink, isApplicationUrl } from '../src/main/external-links';

describe('which links may leave the application', () => {
  it('opens the schemes a person means by a link', () => {
    expect(decideExternalLink('https://example.com/docs')).toEqual({ open: true, url: 'https://example.com/docs' });
    expect(decideExternalLink('http://example.com')).toMatchObject({ open: true });
    expect(decideExternalLink('mailto:dev@example.com')).toMatchObject({ open: true });
  });

  it('returns the parsed URL, so the shell gets the value that was inspected', () => {
    const decision = decideExternalLink('https://example.com');
    expect(decision).toEqual({ open: true, url: 'https://example.com/' });
  });

  it('refuses the schemes that would start local software', () => {
    // A link arrives in terminal output, which is untrusted, and the operating
    // system will do far more with these than open a web page: file: reaches the
    // local disk, smb: leaks credentials to a network share, and applications
    // register their own schemes, some taking a path or a command.
    for (const url of [
      'file:///etc/passwd',
      'file://C:/Windows/System32/calc.exe',
      'smb://attacker.example/share',
      'vscode://file/etc/passwd',
      'ms-msdt:/id PCWDiagnostic',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>'
    ]) {
      const decision = decideExternalLink(url);
      expect(decision.open, url).toBe(false);
    }
  });

  it('names the scheme it refused, so the user can judge what happened', () => {
    expect(decideExternalLink('file:///etc/passwd')).toMatchObject({ open: false, reason: expect.stringContaining('file') });
  });

  it('decides the scheme by parsing, not by pattern matching', () => {
    // A regex over the raw string is what gets these wrong: leading whitespace
    // and an embedded tab are both discarded before a browser reads the scheme.
    expect(decideExternalLink(' javascript:alert(1)').open).toBe(false);
    expect(decideExternalLink('java\tscript:alert(1)').open).toBe(false);
    expect(decideExternalLink('JavaScript:alert(1)').open).toBe(false);
    // Casing of an allowed scheme is not meaningful, though.
    expect(decideExternalLink('HTTPS://example.com').open).toBe(true);
  });

  it('refuses what is not a link at all', () => {
    expect(decideExternalLink('').open).toBe(false);
    expect(decideExternalLink('   ').open).toBe(false);
    expect(decideExternalLink('example.com').open).toBe(false);
    expect(decideExternalLink(undefined).open).toBe(false);
    expect(decideExternalLink(42).open).toBe(false);
    expect(decideExternalLink(`https://example.com/${'a'.repeat(4000)}`).open).toBe(false);
  });

  it('refuses a URL carrying control characters', () => {
    expect(decideExternalLink('https://example.com/\u0000').open).toBe(false);
    expect(decideExternalLink('https://example.com/a\u001bb').open).toBe(false);
  });
});

describe('telling the app apart from the web', () => {
  it('recognises the window content in development and when packaged', () => {
    expect(isApplicationUrl('http://127.0.0.1:5173/', 'http://127.0.0.1:5173/')).toBe(true);
    expect(isApplicationUrl('file:///C:/app/dist/renderer/index.html', 'file:///C:/app/dist/renderer/index.html')).toBe(true);
    // A hash or a query is the app navigating itself, not leaving.
    expect(isApplicationUrl('http://127.0.0.1:5173/?x=1', 'http://127.0.0.1:5173/')).toBe(true);
  });

  it('treats anywhere else as a link out', () => {
    expect(isApplicationUrl('https://example.com', 'http://127.0.0.1:5173/')).toBe(false);
    // Same host, different page: still a navigation away from the workspace.
    expect(isApplicationUrl('http://127.0.0.1:5173/other.html', 'http://127.0.0.1:5173/')).toBe(false);
    expect(isApplicationUrl('not a url', 'http://127.0.0.1:5173/')).toBe(false);
  });
});
