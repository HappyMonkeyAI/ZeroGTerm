// What "~" means inside a WSL distribution.
//
// A WSL pane's shell reports its directory as `~` unless shell integration is
// installed, and `~` is a symbol rather than a path: it cannot be turned into
// the `\wsl.localhost\...` share path a listing needs. Asking the distro is the
// only way to find out, and it is asked once per distribution and cached.
//
// Deliberately not done by typing `pwd` into the user's pane. That would put a
// command they did not run into their shell history, which is the rule
// cwd-tracker.ts states and keeps. This is a separate, short-lived process.

import { execFile } from 'node:child_process';

/**
 * Distribution names, as they arrive from a session record.
 *
 * The first character must be alphanumeric: a name beginning with a dash would
 * be read by `wsl.exe` as another option rather than as the distribution, and
 * nothing that reaches an argv list should be able to become a flag.
 */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The home directory out of the command's output.
 *
 * Anything that is not a single absolute POSIX path is rejected rather than
 * repaired: this value becomes part of a path that is listed, and a distro that
 * answered something surprising is a distro to give up on.
 */
export function parseWslHome(output: string): string | null {
  const text = output.trim();
  if (!text || text.length > 4096) return null;
  if (!text.startsWith('/')) return null;
  if (/[\r\n\0]/.test(text)) return null;
  return text;
}

/**
 * Ask a distribution where its home directory is.
 *
 * Null on anything unexpected — a distro that is not installed, a name this
 * process will not pass on, a slow or silent answer. The caller shows the pane's
 * "not said where it is yet" state, which is the honest outcome.
 */
export async function wslHomeDirectory(
  distribution: string,
  run: typeof execFile = execFile
): Promise<string | null> {
  if (!NAME.test(distribution)) return null;
  return new Promise((resolve) => {
    // argv, so the distribution name is an argument rather than part of a
    // command line. `printf %s` rather than `echo` because it adds no newline
    // and has no flags to be confused by a path.
    const child = run(
      'wsl.exe',
      ['-d', distribution, '--', 'sh', '-c', 'printf %s "$HOME"'],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        // WSL writes UTF-16 in some configurations; the NULs that leaves are
        // stripped rather than treated as a malformed answer.
        resolve(parseWslHome(String(stdout).split('\0').join('')));
      }
    );
    child.on('error', () => resolve(null));
  });
}
