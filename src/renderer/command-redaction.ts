// What must never be written to the command history.
//
// This module is the reason the feature can be shipped at all. ZeroG's other
// stores avoid the question entirely — session-history "never stores cwd, args,
// or credentials" — and a command history cannot: the whole point is to keep the
// command text. So the question moves here, and is answered by refusing anything
// that looks like it carries a secret.
//
// Two rules shape the whole file.
//
// Refuse the entry, never mask part of it. A command with its value blanked is
// still a record that someone ran `export AWS_SECRET_ACCESS_KEY=` in this
// directory at this time, and the masked form invites a false sense that the
// rest is safe. Dropping it costs one entry.
//
// Prefer a false refusal to a false accept. `SSH_AUTH_SOCK=/tmp/x` is not a
// secret and will be refused anyway, because it matches the shape. Losing a
// harmless entry is invisible; storing a token is not.
//
// None of this catches everything, and it is not claimed to. A secret typed as a
// bare argument to a program nobody has heard of, or piped in from `echo`, looks
// exactly like ordinary text. That limit belongs in SECURITY.md, not in a
// comment promising otherwise.

/** Why an entry was refused. Never carries any part of the command. */
export type RedactionReason =
  | 'secret-assignment'
  | 'credential-flag'
  | 'url-credentials'
  | 'auth-header'
  | 'basic-auth'
  | 'known-token'
  | 'openssl-pass'
  | 'high-entropy';

type Rule = { reason: RedactionReason; pattern: RegExp };

/**
 * Words that make an assignment look like a secret.
 *
 * Matched as a substring of the variable name, so `GH_TOKEN`, `MY_API_KEY_2`
 * and `DB_PASSWORD` all qualify. `KEY` catches `KEYBOARD_LAYOUT=` too, and
 * `AUTH` catches `SSH_AUTH_SOCK=`; both are the intended direction of error.
 */
const SECRET_WORDS = 'TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|APIKEY|ACCESS_KEY|PRIVATE';

const RULES: Rule[] = [
  {
    // `export GH_TOKEN=x`, `AWS_SECRET_ACCESS_KEY=x aws s3 ls`, `env FOO_KEY=x cmd`.
    // Requires a value: a bare `unset GH_TOKEN` reveals nothing.
    reason: 'secret-assignment',
    pattern: new RegExp(
      String.raw`(?:^|[\s;&|(])(?:export\s+|set\s+(?:-x\s+)?|env\s+|declare\s+(?:-x\s+)?)?` +
        String.raw`[A-Za-z0-9_]*(?:${SECRET_WORDS})[A-Za-z0-9_]*\s*=\s*\S`,
      'i'
    )
  },
  {
    // A secret-shaped word immediately before `=`, whatever precedes it. The
    // rule above wants a shell identifier; this one catches the assignments that
    // are not one, of which npm's `//registry.npmjs.org/:_authToken=…` is the
    // one nearly everybody has typed.
    reason: 'secret-assignment',
    pattern: new RegExp(String.raw`(?:${SECRET_WORDS})[A-Za-z0-9_]*\s*=\s*\S`, 'i')
  },
  {
    // Long-form credential flags, with the value attached or separate.
    // Deliberately excludes bare `-p` and `-u`: `docker run -p 8080:80` and
    // `docker run -u 1000:1000` are far more common than the credential use,
    // and refusing every port mapping would make the history useless.
    reason: 'credential-flag',
    pattern: new RegExp(
      String.raw`(?:^|\s)--?(?:pass|password|passwd|passphrase|token|api[-_]?key|secret|auth[-_]?token|credential|bearer)` +
        String.raw`(?:=|\s+)\S`,
      'i'
    )
  },
  {
    // `mysql -pSecret`, `mysqldump -pSecret`. Attached only: a bare `-p` makes
    // the client prompt, which is the safe form and worth keeping.
    reason: 'credential-flag',
    pattern: /\bmysql(?:dump|admin)?\b[^\r\n]*\s-p\S/i
  },
  {
    // `https://user:pass@host`, `postgres://u:p@host`. Excludes `host:port/path`
    // by requiring the `@`.
    reason: 'url-credentials',
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i
  },
  {
    // `-H 'Authorization: Bearer x'`, `--header "X-Api-Key: x"`.
    reason: 'auth-header',
    pattern: /(?:-H|--header)\s*["']?\s*(?:authorization|proxy-authorization|x-api-key|x-auth-token)\s*:/i
  },
  {
    // `curl -u user:pass`. Scoped to the HTTP clients, because `-u` means a user
    // id to docker, chown and su.
    reason: 'basic-auth',
    pattern: /\b(?:curl|wget|http|https)\b[^\r\n]*\s-u\s*\S+:\S/i
  },
  {
    // Vendor-shaped tokens, which are unambiguous wherever they appear —
    // including as a bare argument, which no other rule here can catch.
    reason: 'known-token',
    pattern: new RegExp(
      [
        String.raw`gh[pousr]_[A-Za-z0-9]{16,}`,
        String.raw`github_pat_[A-Za-z0-9_]{20,}`,
        String.raw`sk-(?:ant-)?[A-Za-z0-9_-]{16,}`,
        String.raw`xox[baprs]-[A-Za-z0-9-]{10,}`,
        String.raw`AKIA[0-9A-Z]{16}`,
        String.raw`ASIA[0-9A-Z]{16}`,
        String.raw`AIza[0-9A-Za-z_-]{30,}`,
        String.raw`glpat-[A-Za-z0-9_-]{16,}`,
        String.raw`npm_[A-Za-z0-9]{30,}`,
        String.raw`dop_v1_[a-f0-9]{60,}`,
        String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.`
      ].join('|')
    )
  },
  {
    reason: 'openssl-pass',
    pattern: /-pass(?:in|out)\s+(?:pass|env|file):/i
  }
];

/**
 * A word long enough and mixed enough to be a token rather than a path or hash.
 *
 * Deliberately narrow. A git SHA is forty hex characters and completely
 * harmless, so hex-only words are excluded — refusing every `git show <sha>`
 * would gut the history. What is left is a long word carrying upper case, lower
 * case and a digit, which is what generated credentials look like and what
 * filenames, flags and hashes do not.
 */
const ENTROPY_MIN_LENGTH = 24;

export function looksHighEntropy(word: string): boolean {
  if (word.length < ENTROPY_MIN_LENGTH) return false;
  // Paths and URLs are long and mixed but not secrets.
  if (/[/\\]/.test(word)) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(word)) return false;
  if (/^[0-9a-f]+$/i.test(word)) return false;
  return /[a-z]/.test(word) && /[A-Z]/.test(word) && /[0-9]/.test(word);
}

/**
 * Why this command must not be stored, or null when it may be.
 *
 * Returns the reason rather than a boolean so a refusal can be counted and
 * explained — "3 commands were not recorded" — without the content going
 * anywhere near a log.
 */
export function redactionReason(command: string): RedactionReason | null {
  const text = command.trim();
  if (!text) return null;
  for (const { reason, pattern } of RULES) {
    if (pattern.test(text)) return reason;
  }
  // Split on whitespace and on the separators a value hides behind, so
  // `--flag=TOKEN` and `key:TOKEN` are examined as their parts.
  for (const word of text.split(/[\s=:,'"`]+/)) {
    if (looksHighEntropy(word)) return 'high-entropy';
  }
  return null;
}

/** May this command be written to the history? */
export function isStorable(command: string): boolean {
  return redactionReason(command) === null;
}
