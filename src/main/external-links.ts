// Deciding which links may leave the application, and by which door.
//
// A link in a pane is not something the user wrote: it arrives in terminal
// output, which SECURITY.md is explicit about treating as untrusted. Worse, OSC 8
// lets a remote host display one thing and link to another, so the URL handed
// over here has no relationship to the text the user clicked on.
//
// The operating system will do a great deal with a URL. `file:` reaches the local
// disk; on Windows `smb:` reaches a network share and leaks credentials to it;
// and installed applications register their own schemes, some of which take a
// path or a command. Handing any of those to the shell on a single click would
// make a remote host's output into a way of starting local software. So this is
// an allowlist, not a blocklist: the schemes a person means when they click a
// link in a terminal, and nothing else.
//
// Kept pure and free of Electron so the rule can be tested directly.

/** Schemes worth opening: the web, and an address to write to. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * A URL is only long enough to be suspicious once it is absurd. The limit is
 * here because the string is passed to the operating system, not because a real
 * link is ever near it.
 */
const MAX_URL = 2048;

/** Written as escapes: a literal control character in source is invisible. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

export type LinkDecision =
  | { open: true; url: string }
  | { open: false; reason: string };

/**
 * Should this link be handed to the system browser?
 *
 * The URL is re-parsed rather than pattern-matched: a scheme is only what the
 * parser says it is, and `java\tscript:` or a leading space are not the checks a
 * regex tends to get right. The parsed form is what gets returned, so the value
 * that reaches the shell is the one that was inspected.
 */
export function decideExternalLink(value: unknown): LinkDecision {
  if (typeof value !== 'string' || !value.trim()) {
    return { open: false, reason: 'That link is empty.' };
  }
  if (value.length > MAX_URL) {
    return { open: false, reason: 'That link is too long to open.' };
  }
  // A control character cannot appear in a URL, and its presence means the value
  // was assembled to be read one way and used another.
  if (CONTROL_CHARACTER.test(value)) {
    return { open: false, reason: 'That link contains control characters.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { open: false, reason: 'That is not a link this can open.' };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    // Name the scheme: the user clicked something that looked like a link, and
    // "refused" without saying why is not enough to judge what just happened.
    return { open: false, reason: `ZeroG only opens web links; this one is ${parsed.protocol.replace(':', '')}.` };
  }
  return { open: true, url: parsed.href };
}

/**
 * Is this URL the application's own window content?
 *
 * Used to tell a genuine outward link from the app navigating itself — the dev
 * server and the packaged `file:` index are the only two things the window is
 * ever meant to be showing.
 */
export function isApplicationUrl(value: string, current: string): boolean {
  if (value === current) return true;
  try {
    const target = new URL(value);
    const app = new URL(current);
    return target.origin === app.origin && target.pathname === app.pathname;
  } catch {
    return false;
  }
}
