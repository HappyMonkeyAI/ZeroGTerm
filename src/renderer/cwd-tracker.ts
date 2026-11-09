// Working out where a session's shell currently is, from its output alone.
//
// Nothing is ever typed into the session to find this out. A shell's working
// directory is not knowable from outside the pty — and for a remote shell not
// even from the host — so the only honest options are to read what the shell
// volunteers, or to inject a `pwd` and pollute the user's scrollback and shell
// history with it. This module does the former, and reports nothing rather than
// guessing when the shell volunteers nothing.
//
// Two signals, in order of trust:
//
//  1. OSC 7, the sequence a shell emits precisely to say "I am now here". Exact
//     when present, but many distributions do not configure it.
//  2. The path inside the prompt itself, which most default prompts contain.
//     Loose by nature, so it is only accepted when it looks unambiguously like
//     an absolute or home-relative path.
//
// Kept out of main.tsx so it can be unit tested: main.tsx calls createRoot at
// module scope and cannot be imported from a test.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** OSC 7, whose payload is a file: URL naming the shell's directory. */
const OSC7 = new RegExp(ESC + '\\]7;([^' + BEL + ESC + ']*)(?:' + BEL + '|' + ESC + '\\\\)', 'g');
const OSC_ANY = new RegExp(ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)', 'g');
const CSI_ANY = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g');

/** How much output to keep. Enough for a prompt split across several reads. */
export const CWD_BUFFER_CHARS = 2048;

export type CwdReading = {
  /** Either absolute, or `~`-prefixed when that is all the shell revealed. */
  path: string;
  source: 'osc7' | 'prompt';
};

/**
 * The directory named by an OSC 7 payload.
 *
 * The payload is a URL — `file://host/path` — with the path percent-encoded, so
 * a directory containing a space or a `#` arrives escaped and has to be decoded
 * before it means anything to a filesystem.
 */
export function parseOsc7Payload(payload: string): string | null {
  const match = payload.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!match) return null;
  try {
    const path = decodeURIComponent(match[1]);
    return path.includes('\0') ? null : path;
  } catch {
    // A malformed escape means the sequence was not what it claimed to be.
    return null;
  }
}

/**
 * The path in the last prompt, if the prompt shows one.
 *
 * Deliberately narrow: it must be preceded by a colon or whitespace, contain no
 * spaces, and be followed by one of the prompt-ending characters. A prompt that
 * shows only the directory's base name (`[user@host proj]$`) is rejected rather
 * than turned into a path that would be wrong at any depth below the home
 * directory. Windows prompts (`PS C:\Users\me>`) are rejected for the same
 * reason they cannot be used remotely: this reading feeds a POSIX path.
 */
export function parsePromptPath(buffer: string): string | null {
  const plain = buffer.replace(OSC_ANY, '').replace(CSI_ANY, '').replace(/\r/g, '\n');
  const lines = plain.split('\n').filter((line) => line.trim());
  const last = lines[lines.length - 1];
  if (!last) return null;
  const match = last.match(/(?:^|[:\s])(~|~\/[^\s:]*|\/[^\s:]*)\s*[#$%>]\s*$/);
  if (!match) return null;
  const path = match[1].replace(/\/+$/, '') || '/';
  return path;
}

/**
 * What the buffered output says about the shell's directory, or null when it
 * says nothing. The newest OSC 7 wins over the prompt: it is the shell stating
 * a fact, where the prompt is this module inferring one.
 */
export function readCwd(buffer: string, options?: { windows?: boolean }): CwdReading | null {
  let payload: string | null = null;
  for (const match of buffer.matchAll(OSC7)) payload = match[1];
  if (payload) {
    const path = options?.windows ? parseWindowsOsc7Payload(payload) : parseOsc7Payload(payload);
    if (path) return { path, source: 'osc7' };
  }
  const prompt = (options?.windows ? parseWindowsPromptPath(buffer) : null) ?? parsePromptPath(buffer);
  return prompt ? { path: prompt, source: 'prompt' } : null;
}

/**
 * Whether a session's shell reports Windows paths: PowerShell or cmd running
 * on this machine. Only these get the Windows readings below — a remote shell's
 * directory feeds the transfer panel, which needs a POSIX path, and a local WSL
 * or Git Bash pane prints POSIX prompts of its own.
 */
export function reportsWindowsPaths(session: { kind: string; backend?: string }): boolean {
  return session.kind === 'local' && (session.backend === 'powershell' || session.backend === 'pwsh' || session.backend === 'cmd');
}

/**
 * The directory in a PowerShell or cmd prompt: `PS C:\Users\dev>` or `C:\Users\dev>`.
 *
 * Unlike a POSIX prompt this may contain spaces (`C:\Program Files`), because
 * the default prompts print the whole path and nothing else, so the line has to
 * be exactly prompt-shaped: an optional `PS `, a drive path, and `>` at the end.
 * A line with a command typed after the `>` is not a prompt any more.
 */
export function parseWindowsPromptPath(buffer: string): string | null {
  const plain = buffer.replace(OSC_ANY, '').replace(CSI_ANY, '').replace(/\r/g, '\n');
  const lines = plain.split('\n').filter((line) => line.trim());
  const last = lines[lines.length - 1];
  if (!last) return null;
  const match = last.match(/^\s*(?:PS )?([A-Za-z]:\\[^<>|"*?]*?)>\s*$/);
  if (!match) return null;
  return trimWindowsPath(match[1]);
}

/**
 * The directory in an OSC 7 payload from a Windows shell.
 *
 * Takes the proper URL form, `file://host/C:/Users/dev`, and also the form the
 * PowerShell snippet once wrote, with host and path run together and no slash
 * between them (`file://PCC:\Users\dev`), which is still in people's profiles.
 * A drive letter cannot be mistaken for the end of the host: `:` is not legal
 * in a host name, so the shortest host that leaves `X:\` behind is the right one.
 */
export function parseWindowsOsc7Payload(payload: string): string | null {
  const url = payload.match(/^file:\/\/[^/]*\/([A-Za-z]:[\\/].*)$/);
  const joined = url ? null : payload.match(/^file:\/\/[^/\\:]*?([A-Za-z]:\\.*)$/);
  const raw = url?.[1] ?? joined?.[1];
  if (!raw) return null;
  let path: string;
  try {
    path = url ? decodeURIComponent(raw) : raw;
  } catch {
    return null;
  }
  if (path.includes('\0')) return null;
  return trimWindowsPath(path.replace(/\//g, '\\'));
}

/** Drop a trailing backslash, except the one that makes `C:\` the root. */
function trimWindowsPath(path: string): string {
  const trimmed = path.replace(/\\+$/, '');
  return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}\\` : trimmed;
}

/**
 * Where the transfer panel should start, given what the terminal's breadcrumb
 * currently says.
 *
 * A `~`-prefixed reading cannot be handed to the remote side as-is: `~` is a
 * shell's expansion, and the SFTP client is not a shell. It is resolved against
 * the directory the connection actually lands in instead, which is the same
 * login directory the shell expanded `~` to.
 */
export function resolveStartPath(cwd: string | undefined): { absolute?: string; homeRelative?: string } {
  if (!cwd || cwd === '~' || cwd === '~/') return {};
  if (cwd.startsWith('/')) return { absolute: cwd };
  if (cwd.startsWith('~/')) return { homeRelative: cwd.slice(2) };
  return {};
}
