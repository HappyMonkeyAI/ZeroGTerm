// Where a pane's browser should look, and what to type to move the shell there.
//
// Two jobs, both of them about the gap between what a shell thinks its directory
// is and what this side can list.
//
// For an SSH pane there is no gap: the sftp connection lists the same paths the
// remote shell uses. For a native local shell there is no gap either. For WSL
// there is a real one — the shell is inside the distro and this side is on
// Windows — and it is bridged by `\\wsl.localhost\<distro>\…`, which Windows
// serves for every running distribution. That is why the WSL case needs no
// `wsl.exe -- ls` of its own.
//
// The second job is the dangerous one. Every other place this codebase hands a
// path to something executable, it goes as an argv element behind a `--`. Here
// it goes into a shell line, and the name was chosen by whatever is on the far
// end — so quoting is the entire defence, and it is the reason this module is
// pure and tested rather than three template strings at a call site.

import type { SessionInfo } from '../shared/types';

/** How a shell wants a path quoted. Three families, three answers. */
export type ShellFamily = 'posix' | 'powershell' | 'cmd';

/** Where the browser lists, and what kind of path that is. */
export type PathKind = 'posix' | 'windows' | 'unc';

/**
 * The share Windows serves a running distribution's filesystem on.
 *
 * `\\wsl.localhost\` is the current spelling and `\\wsl$\` the older one; both
 * work on Windows 11, and only the older one works on early WSL 2 builds. Paths
 * are built with the current spelling and read with either, so a path that
 * arrives in the old form is still understood.
 */
const WSL_SHARES = ['\\\\wsl.localhost\\', '\\\\wsl$\\'];

/**
 * How a shell of each family is quoted, or why it cannot be.
 *
 * A newline is refused for every family before anything else: it ends the
 * command line, so no amount of quoting stops the rest becoming a second
 * command. That is the only case where the answer is the same everywhere.
 */
export type DirectoryCommand = { command: string } | { refused: string };

export function shellFamily(session: SessionInfo | null | undefined): ShellFamily | null {
  if (!session) return null;
  if (session.kind === 'ssh') return 'posix';
  switch (session.backend) {
    case 'powershell':
    case 'pwsh':
      return 'powershell';
    case 'cmd':
      return 'cmd';
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'sh':
    case 'wsl':
    case 'screen':
      return 'posix';
    default:
      // A session restored from history may name no backend. Refusing beats
      // guessing: the wrong quoting rule is a command the user did not ask for.
      return null;
  }
}

/** Is this pane's shell inside a WSL distribution? */
export function isWslSession(session: SessionInfo | null | undefined): boolean {
  return Boolean(session && session.kind === 'local' && session.backend === 'wsl' && session.wslDistribution);
}

/**
 * A distro path as Windows can reach it.
 *
 * The share root needs something after it — `readdirSync` on the bare share
 * fails — so `/` becomes `…\.` rather than a trailing separator.
 */
export function wslUncPath(distribution: string, posixPath: string): string {
  const trimmed = posixPath.replace(/\/+$/, '');
  const segments = trimmed.split('/').filter(Boolean);
  const tail = segments.length ? segments.join('\\') : '.';
  return `${WSL_SHARES[0]}${distribution}\\${tail}`;
}

/**
 * The distro path a UNC path names, or null when it names something else.
 *
 * Null matters: a path outside the distribution's share is not somewhere the
 * shell inside it can be told to go, and inventing a translation would produce
 * a `cd` to a directory that does not exist there.
 */
export function wslPosixPath(distribution: string, uncPath: string): string | null {
  const normalized = uncPath.replace(/\//g, '\\');
  for (const share of WSL_SHARES) {
    const prefix = `${share}${distribution}`;
    if (!normalized.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const rest = normalized.slice(prefix.length).replace(/^\\+/, '');
    const segments = rest.split('\\').filter((part) => part && part !== '.');
    return `/${segments.join('/')}`;
  }
  return null;
}

/** What kind of path this pane's browser is walking. */
export function pathKindFor(session: SessionInfo | null | undefined): PathKind | null {
  if (!session) return null;
  if (session.kind === 'ssh') return 'posix';
  if (isWslSession(session)) return 'unc';
  if (session.backend === undefined) return null;
  // A native local shell browses this machine, whose paths are the platform's.
  return session.host === 'local' && /^[A-Za-z]:/.test(session.cwd ?? '') ? 'windows' : 'posix';
}

/**
 * Where the browser should list, given where the shell says it is.
 *
 * Returns null when the shell has not said anything usable yet — a WSL pane
 * reporting `~` has no path to translate, and the browser says so rather than
 * guessing at a home directory.
 */
export function listingPathFor(session: SessionInfo | null | undefined, home?: string): string | null {
  if (!session) return null;
  const reported = resolveHome(session.cwd, home);
  if (!reported) return null;
  if (isWslSession(session)) {
    // A shell inside the distro reports a distro path, including `/mnt/c/...`
    // for the Windows drives — which the share serves too, so there is one rule
    // here rather than two.
    if (!reported.startsWith('/')) return null;
    return wslUncPath(session.wslDistribution as string, reported);
  }
  return reported;
}

/**
 * Where a pane's browser should start, before its shell has said anything.
 *
 * A freshly connected SSH pane has reported no directory at all: nothing has
 * run in it, so neither OSC 7 nor a prompt has been seen. The browser used to
 * show "this pane has not said where it is yet" until a command was run, which
 * is a poor first impression of a feature whose whole job is to save you typing
 * one — and it was reported as exactly that.
 *
 * The login directory answers it without touching the user's terminal: sftp
 * reports it on connecting, and a WSL distribution is asked directly. That is
 * the same bargain cwd-tracker keeps — read what is volunteered, never inject a
 * command to find out.
 */
export function startingListingPath(session: SessionInfo | null | undefined, home?: string): string | null {
  const reported = listingPathFor(session, home);
  if (reported) return reported;
  if (!session || !home) return null;
  // Translated the same way any other path is, so a WSL pane still gets its
  // share path rather than a distro path Windows cannot read.
  return listingPathFor({ ...session, cwd: home }, home);
}

/** The path to put in a `cd`, given what the browser is showing. */
export function shellPathFor(session: SessionInfo | null | undefined, listingPath: string): string | null {
  if (!session) return null;
  if (!isWslSession(session)) return listingPath;
  return wslPosixPath(session.wslDistribution as string, listingPath);
}

/**
 * `~` is not a path anything here can translate.
 *
 * A shell whose prompt says `~` has told us a symbol, not a directory. Where the
 * caller knows the home directory — resolved once per distribution, or the local
 * one — it is substituted; otherwise this reports nothing, and the browser waits
 * for the shell to say something concrete.
 */
export function resolveHome(cwd: string | undefined, home?: string): string | null {
  if (!cwd) return null;
  if (cwd === '~') return home ?? null;
  if (cwd.startsWith('~/')) return home ? `${home.replace(/\/+$/, '')}/${cwd.slice(2)}` : null;
  return cwd;
}

/**
 * The parent of a path, or null at a root.
 *
 * Null is the point: a browser that offers `..` at `/` or at a share root would
 * either do nothing or climb out of the distribution it is meant to be showing.
 */
export function parentOf(path: string, kind: PathKind): string | null {
  if (kind === 'posix') {
    const trimmed = path.replace(/\/+$/, '');
    if (!trimmed || trimmed === '') return null;
    const at = trimmed.lastIndexOf('/');
    if (at < 0) return null;
    return at === 0 ? '/' : trimmed.slice(0, at);
  }

  if (kind === 'windows') {
    const trimmed = path.replace(/[\\/]+$/, '');
    // `C:` alone is the drive root, which has no parent.
    if (/^[A-Za-z]:$/.test(trimmed)) return null;
    const at = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (at < 0) return null;
    const parent = trimmed.slice(0, at);
    return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
  }

  // UNC: never above `\\server\share`, which is the distribution's root.
  const normalized = path.replace(/\//g, '\\').replace(/\\+$/, '');
  const match = normalized.match(/^(\\\\[^\\]+\\[^\\]+)(?:\\(.*))?$/);
  if (!match) return null;
  const [, share, rest = ''] = match;
  const segments = rest.split('\\').filter((part) => part && part !== '.');
  if (!segments.length) return null;
  segments.pop();
  return segments.length ? `${share}\\${segments.join('\\')}` : `${share}\\.`;
}

// A newline or carriage return ends the command line, so nothing after it is
// quoted any more — it is a second command. Built from character codes rather
// than a literal for the reason remote-screens.ts gives: an invisible control
// character in source is too easy to destroy in a later edit.
const LINE_BREAK = new RegExp('[' + String.fromCharCode(10) + String.fromCharCode(13) + ']');

/**
 * The line to type to move a shell into a directory.
 *
 * The name came from a listing — a remote host's, or a filesystem someone else
 * can write to — so it is hostile input reaching a shell. Each family gets the
 * quoting that actually holds there:
 *
 * POSIX single quotes take everything literally, and the only character that
 * needs care is the quote itself, closed and reopened around a backslashed one.
 *
 * PowerShell single quotes work the same way with the quote doubled, but
 * `Set-Location` treats its argument as a wildcard pattern — a directory
 * genuinely named `[test]` would not be found — so `-LiteralPath` is what makes
 * the quoting mean anything.
 *
 * cmd has no escape for a double quote inside a quoted string, so a name
 * containing one is refused rather than approximated. `/d` is needed because
 * `cd` alone will not change drive.
 */
export function changeDirectoryCommand(family: ShellFamily, path: string): DirectoryCommand {
  if (!path) return { refused: 'That directory has no path.' };
  if (LINE_BREAK.test(path)) {
    return { refused: 'That directory name contains a line break, which cannot be typed safely.' };
  }

  if (family === 'posix') {
    return { command: `cd '${path.split("'").join(String.raw`'\''`)}'` };
  }
  if (family === 'powershell') {
    return { command: `Set-Location -LiteralPath '${path.split("'").join("''")}'` };
  }
  if (path.includes('"')) {
    return { refused: 'Command Prompt cannot quote a directory name containing a double quote.' };
  }
  return { command: `cd /d "${path}"` };
}

/**
 * A child path, in whichever separator this pane's paths use.
 *
 * Kept here rather than using node:path, which the renderer does not have and
 * which would in any case answer for the wrong platform: a WSL pane's paths are
 * UNC while the app may be running anywhere.
 */
export function joinPath(parent: string, name: string, kind: PathKind): string {
  if (kind === 'posix') return parent === '/' ? `/${name}` : `${parent.replace(/\/+$/, '')}/${name}`;
  // Windows and UNC both use backslashes, and a share root carries a trailing
  // `\.` that a child replaces rather than extends.
  const base = parent.replace(/\\\.$/, '').replace(/[\\/]+$/, '');
  return `${base}\\${name}`;
}
