// Reading and writing OpenSSH's interactive sftp client.
//
// ZeroG drives the system `sftp` binary rather than speaking the SFTP protocol
// itself, for the same reason it drives system `ssh` for terminals: the client
// already honours ~/.ssh/config, ProxyJump, the agent, and known_hosts. The
// price is that its answers arrive as text written for a person, so everything
// in this module is about turning that text back into data — and about never
// letting a filename be read as anything but a filename.
//
// Kept free of state and of node-pty so the parsing can be tested directly.

import { stripAnsi } from '../shared/ansi.js';
import { parseSshTarget } from './session-service.js';
import { findOpenSshTool, type ShellCatalogOptions } from './shell-catalog.js';
import type { FileEntry } from '../shared/types.js';

/** What the client prints when it is ready for another command. */
const PROMPT = 'sftp> ';

/**
 * Characters a path may not contain.
 *
 * `sftp` has a command interpreter: it splits a line into words, strips one
 * layer of quoting, and then hands file arguments to a *glob* expander. Two
 * unescaping passes with different rules means a filename containing a quote,
 * a backslash or a glob character has no encoding that is provably correct for
 * every command — and being approximately right about which file to delete is
 * not good enough. Such names are refused with a message instead, which costs
 * the user very little: these characters are rare in real filenames and illegal
 * in Windows ones.
 *
 * Every control character goes with them. NUL terminates the path for the C
 * library underneath; carriage return and newline would end the command, since
 * a command is one line; and tab is what the client's own argument splitter
 * breaks words on. A quoted tab does survive that splitter today — but the whole
 * point of this list is to avoid betting a delete on the client's undocumented
 * parsing rules, and a filename containing an escape character or a bell is not
 * a case worth taking that bet for.
 */
const UNSAFE_PATH = /[\u0000-\u001f\u007f-\u009f"'\\*?[\]]/;
/** The same control characters again, for telling the user which rule they hit. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_PATH = 4096;

export function isSafeRemotePath(path: string): boolean {
  return path.length > 0 && path.length <= MAX_PATH && !UNSAFE_PATH.test(path);
}

function describeUnsafe(path: string): string {
  if (!path) return 'the path is empty';
  if (path.length > MAX_PATH) return 'the path is too long';
  if (CONTROL_CHARACTER.test(path)) return 'names containing control characters are not supported';
  return 'names containing quotes, backslashes, or the wildcard characters * ? [ ] are not supported yet';
}

/**
 * A path as one quoted word for the sftp command line.
 *
 * Only spaces and ordinary punctuation survive validation, so double quotes are
 * enough on their own: the interpreter strips them and the glob pass sees a
 * literal name with no metacharacters left in it.
 */
export function quoteRemotePath(path: string): string {
  if (!isSafeRemotePath(path)) {
    throw new Error(`Cannot use this path over SFTP: ${describeUnsafe(path)}`);
  }
  return `"${path}"`;
}

/**
 * A local path the sftp client will accept as one word.
 *
 * Windows paths are separator-translated rather than escaped: `C:\Users\me`
 * would lose its backslashes to the interpreter, while Windows itself accepts
 * forward slashes everywhere, so `C:/Users/me` reaches the same file with
 * nothing left for the interpreter to eat.
 */
export function quoteLocalPath(path: string): string {
  return quoteRemotePath(path.replace(/\\/g, '/'));
}

/**
 * The absolute path to the OpenSSH sftp client.
 *
 * A bare command name is not enough: node-pty hands the file straight to
 * CreateProcess on Windows, which does not append `.exe`, so a pty asked for
 * `sftp` dies with "File not found" on a machine that plainly has it. Where
 * OpenSSH is looked for lives in findOpenSshTool, shared with the terminal
 * side's sshExecutable — the two tools ship together, so they should be found
 * the same way.
 */
export function sftpExecutable(options: ShellCatalogOptions = {}): string {
  const file = findOpenSshTool('sftp', options);
  if (!file) {
    throw new Error('The OpenSSH sftp client was not found. Install the OpenSSH client tools to transfer files.');
  }
  return file;
}

/**
 * The sftp client invocation for an SSH target.
 *
 * Reuses the terminal side's target parser so a destination that ssh would read
 * as an option cannot reach sftp either. ConnectTimeout is set because the panel
 * has to be able to report a dead host rather than sit on a spinner; everything
 * else — keys, proxies, host key policy — is left to the user's ssh config.
 */
export function buildSftpArgs(target: string, options: ShellCatalogOptions = {}): { file: string; args: string[] } {
  const { destination, port } = parseSshTarget(target);
  const args = ['-o', 'ConnectTimeout=20'];
  if (port) args.push('-P', port);
  args.push(destination);
  return { file: sftpExecutable(options), args };
}

/** Has the client finished answering and asked for the next command? */
export function endsWithPrompt(buffer: string): boolean {
  return stripAnsi(buffer).trimEnd().endsWith(PROMPT.trimEnd());
}

/**
 * The client's answer, with the echoed command and trailing prompt removed.
 *
 * The client runs on a pty so that it can ask for a password, and a pty echoes
 * what was typed into it — so the first thing in every response is the command
 * itself.
 */
export function responseBody(buffer: string, command: string): string {
  const text = stripAnsi(buffer).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const wanted = command.trim();
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === wanted || line.trim().endsWith(PROMPT + wanted));
  const body = start >= 0 ? lines.slice(start + 1) : lines;
  return body
    .filter((line) => line.trim() !== PROMPT.trim())
    .join('\n')
    .replace(/sftp>\s*$/, '')
    .trimEnd();
}

/**
 * A `ls -l` record, as loosely as it can be matched while still being one.
 *
 * The mode and link-count columns are deliberately permissive: the format is
 * the *server's* choice, and servers do vary. OpenSSH's MSYS build, for one,
 * prints `drwx******` for a mode and `?` where the link count goes. Being strict
 * about columns nothing here reads would turn a directory of files into an empty
 * pane. What the panel actually needs — kind, size, date, name — is matched
 * exactly.
 */
const LS_LINE =
  /^([dlbcps-][rwxsStT*?+-]{9}[.+@]?)\s+[\d?]+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{4}|\d{1,2}:\d{2}))\s+(.+)$/;

/**
 * One `ls -l` record, or null when the line is something else — a banner, a
 * blank, or an error. The name is taken as the whole remainder of the line so
 * that spaces in it survive; the columns before it are fixed in number.
 */
export function parseLsLine(line: string): FileEntry | null {
  const match = line.trimEnd().match(LS_LINE);
  if (!match) return null;
  const [, permissions, size, modified, rest] = match;
  const kind = permissions.startsWith('d') ? 'directory' : permissions.startsWith('l') ? 'symlink' : 'file';
  // A symlink record ends with " -> target"; the arrow is not part of the name.
  const arrow = kind === 'symlink' ? rest.lastIndexOf(' -> ') : -1;
  const name = arrow > 0 ? rest.slice(0, arrow) : rest;
  const linkTarget = arrow > 0 ? rest.slice(arrow + 4) : undefined;
  if (!name || name === '.' || name === '..') return null;
  return { name, kind, size: Number(size), modified, permissions, ...(linkTarget ? { linkTarget } : {}) };
}

export function parseListing(text: string): FileEntry[] {
  return text.split('\n').flatMap((line) => {
    const entry = parseLsLine(line);
    return entry ? [entry] : [];
  });
}

/** The directory `pwd` reported, which is the server's canonical form of it. */
export function parsePwd(text: string): string | null {
  const match = text.match(/Remote working directory:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

const ERROR_LINE = [
  /^(?:couldn't|can't|cannot|unable to)\b/i,
  /^remote (?:readdir|open|stat|lstat|mkdir|rmdir|unlink|rename)\b/i,
  /:\s*(?:no such file or directory|permission denied|failure|not a directory|is a directory|file exists|operation unsupported|no space left on device|connection closed)\.?$/i,
  /\bnot found\.?$/i,
  /^permission denied/i,
  /^connection closed/i,
  /^host key verification failed/i,
  /^ssh: /i,
  /^invalid command/i
];

/**
 * The first line of a response that reports a failure.
 *
 * The client's exit status is not available — it stays alive for the next
 * command — so a failed operation is only distinguishable by what it printed.
 * Lines that parse as directory records are skipped first, so a file whose name
 * happens to read like an error message cannot be mistaken for one.
 */
export function findError(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || parseLsLine(raw)) continue;
    if (ERROR_LINE.some((pattern) => pattern.test(line))) return line;
  }
  return null;
}

/**
 * A frame of the transfer progress meter, which the client only prints because
 * it is talking to a pty. Meter frames overwrite each other with carriage
 * returns, so the caller passes the latest chunk and takes the last frame in it.
 */
export function parseProgress(chunk: string): { name: string; percent: number; detail: string } | null {
  const frames = stripAnsi(chunk).split(/[\r\n]/).reverse();
  for (const frame of frames) {
    const match = frame.match(/^(.*?)\s{2,}(\d{1,3})%\s+(.*?)\s*$/);
    if (!match) continue;
    const percent = Number(match[2]);
    if (percent > 100 || !match[1].trim()) continue;
    return { name: match[1].trim(), percent, detail: match[3].trim() };
  }
  return null;
}

/**
 * A question the connection is waiting on, if the tail of the output is one.
 *
 * Detection runs on the tail rather than line-by-line because these prompts are
 * written without a trailing newline — the cursor is left on the prompt line,
 * which is precisely what makes them a question rather than a message.
 */
export function detectPrompt(buffer: string): { kind: 'password' | 'passphrase' | 'confirm'; text: string } | null {
  const text = stripAnsi(buffer).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const tail = text.slice(-600);
  if (/\(yes\/no(?:\/\[fingerprint\])?\)\?\s*$/i.test(tail) || /type 'yes', 'no' or the fingerprint:\s*$/i.test(tail)) {
    // Carry the whole authenticity notice, fingerprint included: the user is
    // being asked to vouch for a key, and cannot do that from the last line.
    const notice = tail.lastIndexOf('The authenticity of host');
    return { kind: 'confirm', text: (notice >= 0 ? tail.slice(notice) : tail).trim() };
  }
  const lastLine = tail.split('\n').pop() ?? '';
  if (/passphrase for key/i.test(lastLine) && /:\s*$/.test(lastLine)) {
    return { kind: 'passphrase', text: lastLine.trim() };
  }
  if (/(?:password|verification code|one-time password):\s*$/i.test(lastLine)) {
    return { kind: 'password', text: lastLine.trim() };
  }
  return null;
}

/**
 * The last thing the client actually said, for putting in an error.
 *
 * A timeout can only report that nothing arrived, which is the least useful
 * sentence available: whether the host was never reached, asked something
 * unrecognised, or answered and was misparsed are three different problems with
 * the same symptom. The client's own last line separates them.
 */
export function lastClientMessage(buffer: string): string {
  const lines = stripAnsi(buffer)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== PROMPT.trim());
  return lines[lines.length - 1] ?? '';
}

/** A failure that ends the connection rather than one command. */
export function detectFatal(buffer: string): string | null {
  const text = stripAnsi(buffer);
  const patterns = [
    /^ssh: .*$/m,
    /^Permission denied \(.*\)\.?$/m,
    /^Host key verification failed\.?$/m,
    /^.*Connection (?:refused|timed out|closed by remote host).*$/m,
    /^Too many authentication failures.*$/m,
    /^Connection to .* closed by remote host\.?$/m
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

