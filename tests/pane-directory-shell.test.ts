import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changeDirectoryCommand } from '../src/renderer/pane-directory';

/**
 * The quoting, settled by a real shell rather than by a string comparison.
 *
 * Every other test in this suite injects a fake, and rightly. This one does not,
 * because the property being claimed is "a POSIX shell reads this as one `cd`
 * and nothing else", and only a POSIX shell can say whether that is true. An
 * assertion about the shape of the string is a restatement of the code.
 *
 * Skipped where no `sh` is available — a bare Windows machine — rather than
 * failing there. CI runs on Linux, so the checks do run.
 */
function shell(): string | null {
  for (const candidate of ['/bin/sh', '/usr/bin/sh', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe']) {
    try {
      execFileSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* try the next */
    }
  }
  return null;
}

const sh = shell();
const describeShell = sh ? describe : describe.skip;

/** Directory names that would each do something other than change directory. */
const NAMES = [
  'plain',
  'with space',
  "it's here",
  'semi;colon',
  '$(touch pwned)',
  '`touch pwned`',
  'and && or',
  'pipe|it',
  'star*',
  'brackets[1]',
  'quote"inside',
  'dollar$HOME',
  'tab\there',
  '#hash',
  'back\\slash',
  'tilde~here',
  'newline-free!'
];

describeShell('a POSIX shell reads the generated cd as one command', () => {
  it('lands in the directory, whatever it is called', () => {
    const root = mkdtempSync(join(tmpdir(), 'zerog-cd-'));
    let attempted = 0;
    try {
      for (const name of NAMES) {
        const target = join(root, name);
        try {
          mkdirSync(target);
        } catch {
          // Windows filesystems refuse | " * < > ? : in a name, so those cases
          // can only be exercised where the OS allows them. Skipped rather than
          // dropped from the list: on Linux, which is what CI runs, they run.
          continue;
        }
        attempted += 1;

        const built = changeDirectoryCommand('posix', target.replace(/\\/g, '/'));
        expect('command' in built, `refused: ${name}`).toBe(true);
        if (!('command' in built)) continue;

        // `pwd -P` so a symlinked temp directory does not read as a mismatch.
        const output = execFileSync(sh as string, ['-c', `${built.command} && pwd -P`], { encoding: 'utf8' }).trim();
        expect(output.endsWith(name.replace(/\\/g, '/')) || output.endsWith(name), `${name} -> ${output}`).toBe(true);
      }
      // A silent zero would mean the loop proved nothing.
      expect(attempted).toBeGreaterThan(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs nothing the name asked for', () => {
    // The whole point. Each of these names contains a command; after cd'ing into
    // every one of them, none of those commands may have run.
    const root = mkdtempSync(join(tmpdir(), 'zerog-cd-safe-'));
    const sentinels = ['pwned1', 'pwned2', 'pwned3', 'pwned4'];
    try {
      const names = [`$(touch ${sentinels[0]})`, `\`touch ${sentinels[1]}\``, `x; touch ${sentinels[2]}`, `y && touch ${sentinels[3]}`];
      for (const name of names) {
        try {
          mkdirSync(join(root, name));
        } catch {
          continue;
        }
        const built = changeDirectoryCommand('posix', join(root, name).replace(/\\/g, '/'));
        if (!('command' in built)) continue;
        execFileSync(sh as string, ['-c', `${built.command} && pwd -P`], { encoding: 'utf8' });
      }
      // Compared exactly, not by substring: every directory name here *contains*
      // its sentinel, so a substring check would match the name it created and
      // pass whatever happened.
      const entries = readdirSync(root);
      for (const sentinel of sentinels) {
        expect(entries, `${sentinel} was created`).not.toContain(sentinel);
      }
      // And nothing was created in the working directory the shell started in.
      expect(readdirSync(process.cwd()).filter((name) => sentinels.includes(name))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is one command, so nothing can be appended to it', () => {
    // `cd <dir> ; echo APPENDED` would run the echo. That the built command
    // cannot be extended by the *name* is what the previous test shows; this one
    // pins that the command itself contains no unquoted separator.
    const built = changeDirectoryCommand('posix', '/tmp/a; echo APPENDED');
    expect('command' in built).toBe(true);
    if (!('command' in built)) return;
    const output = execFileSync(sh as string, ['-c', `${built.command} 2>/dev/null; true`], { encoding: 'utf8' });
    expect(output).not.toContain('APPENDED');
  });
});
