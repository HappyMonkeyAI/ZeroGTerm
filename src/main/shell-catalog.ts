// Which shells this machine can actually start, and what to spawn for each.
//
// Ported forward from the cross-platform discovery work in 690f01d on
// fix/cross-platform-and-review-fixes, which never reached dev. What shipped
// instead knew only `pwsh.exe`, so a Windows machine without PowerShell 7 — the
// common case, since 7 is a separate install — was offered no PowerShell at
// all, and the two shells Windows always has, Windows PowerShell and Command
// Prompt, could not be chosen. bash was offered unconditionally on every
// platform, including where it cannot start.
//
// Candidates are resolved against PATH rather than probed by spawning them.
// Spawning was slow and wrong in two ways: it cold-started PowerShell on CI,
// which intermittently blew vitest's timeout, and it made `--version` the test
// of existence, which Command Prompt does not answer. Resolving also yields an
// absolute path, which is what node-pty needs on Windows — it does not apply
// PATHEXT, so a bare `bash` fails there with "File not found:".

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { LocalShellBackend, ShellBackend } from '../shared/types.js';

/** Distro names reach `wsl.exe -d <name>`; a leading '-' would read as a flag. */
const WSL_DISTRIBUTION = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * Where a WSL shell should start.
 *
 * `wsl.exe` inherits the Windows directory it was launched from, so without this
 * a new WSL pane opens in `/mnt/c/Users/<name>` — the Windows home seen through
 * the mount, which is almost never where anyone wants to be working. `--cd`
 * takes a Linux path, and `~` is the distro user's own home.
 *
 * Passed as a separate argv element, never through a shell, so the tilde reaches
 * `wsl.exe` literally rather than being expanded on the way.
 */
export const WSL_HOME = '~';

/**
 * `--cd` needs WSL 0.51.2 or newer — Windows 11, or the Store build on Windows
 * 10. On an older inbox WSL the flag is rejected and the pane shows that, which
 * is visible rather than silent. Judged worth it: the flag is four years old,
 * Windows 10 is out of support, and the alternative was a capability probe on
 * every session for a configuration this project does not target.
 */
function wslStartArgs(startDirectory = WSL_HOME): string[] {
  return ['--cd', startDirectory];
}

/**
 * Point a resolved WSL shell at a directory other than the distro's home.
 *
 * Kept separate from resolveShellBackend because that is also what a reattach
 * uses, where the right answer is the home directory again — a fresh shell, not
 * wherever the last one wandered to.
 */
export function withWslStartDirectory(shell: ShellBackend, startDirectory: string): ShellBackend {
  if (shell.backend !== 'wsl') return shell;
  const args = [...shell.args];
  const at = args.indexOf('--cd');
  if (at >= 0 && at + 1 < args.length) args[at + 1] = startDirectory;
  else args.push(...wslStartArgs(startDirectory));
  return { ...shell, args };
}

/**
 * A directory a pty can actually be started in.
 *
 * A session reports the directory its *shell* is in, which for WSL is a path
 * inside the distro — `~`, or `/home/name` once the shell says so. node-pty
 * hands its cwd straight to the OS, and neither of those is a directory Windows
 * can start a process in. Where the shell itself begins is settled by its
 * arguments, so anything unusable here falls back to the home directory rather
 * than failing the spawn.
 */
export function ptyStartDirectory(cwd: string | undefined, options: ShellCatalogOptions & { home?: string } = {}): string {
  const home = options.home ?? homedir();
  if (!cwd) return home;
  const windows = (options.platform ?? process.platform) === 'win32';
  const usable = windows
    ? /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')
    : cwd.startsWith('/');
  return usable ? cwd : home;
}

const LOCAL_SHELL_BACKENDS: readonly LocalShellBackend[] = [
  'bash', 'zsh', 'fish', 'sh', 'powershell', 'pwsh', 'cmd', 'wsl'
];

/**
 * Does this value name a shell?
 *
 * A stored session's backend can also be a transport — 'screen' for a session
 * inside screen, 'ssh' for a remote one — and it arrives from the history file
 * on disk, so it is narrowed rather than asserted.
 */
export function isLocalShellBackend(value: unknown): value is LocalShellBackend {
  return typeof value === 'string' && (LOCAL_SHELL_BACKENDS as readonly string[]).includes(value);
}

export type ShellCatalogOptions = {
  platform?: NodeJS.Platform;
  /** PATH to search. Defaults to the process environment. */
  path?: string;
  /** Windows executable extensions. Defaults to PATHEXT, then a sane list. */
  pathExt?: string;
  /** The user's login shell, so it can be offered first on Unix. */
  loginShell?: string;
  /** Where the Windows install locations are read from. Defaults to the process. */
  env?: NodeJS.ProcessEnv;
  /** Injected so tests can describe a machine without touching the disk. */
  isFile?: (candidate: string) => boolean;
};

type ShellCandidate = {
  backend: LocalShellBackend;
  label: string;
  command: string;
  args?: string[];
};

function defaultIsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolved(options: ShellCatalogOptions) {
  const platform = options.platform ?? process.platform;
  return {
    platform,
    windows: platform === 'win32',
    path: options.path ?? process.env.PATH ?? '',
    pathExt: options.pathExt ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM',
    loginShell: options.loginShell ?? process.env.SHELL,
    env: options.env ?? process.env,
    isFile: options.isFile ?? defaultIsFile
  };
}

/**
 * Path arithmetic for the *target* platform, not the host.
 *
 * node:path's `delimiter`, `sep` and `join` follow whichever platform this code
 * is running on, which is right in production and wrong for reasoning about a
 * platform passed in — splitting a Unix PATH on ';' yields one long entry that
 * matches nothing. Doing it explicitly keeps the module honest either way.
 */
function pathParts(value: string, windows: boolean): string[] {
  return value.split(windows ? ';' : ':').filter(Boolean);
}

function joinPath(directory: string, name: string, windows: boolean): string {
  const separator = windows ? '\\' : '/';
  const trimmed = directory.replace(/[\\/]+$/, '');
  return `${trimmed}${separator}${name}`;
}

function fileName(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

/**
 * Resolve a bare command name against PATH without spawning anything.
 *
 * On Windows the extension is usually part of the command already, but PATHEXT
 * is honoured so `pwsh` finds `pwsh.exe` — the empty extension is tried first so
 * an exact name still wins.
 *
 * `accept` lets a caller reject a match and keep searching later PATH entries,
 * which is what finding Git Bash behind System32's shim requires.
 */
export function findExecutable(
  command: string,
  options: ShellCatalogOptions = {},
  accept: (file: string) => boolean = () => true
): string | undefined {
  const { windows, path, pathExt, isFile } = resolved(options);
  const extensions = windows ? ['', ...pathExt.split(';').filter(Boolean)] : [''];
  for (const directory of pathParts(path, windows)) {
    for (const extension of extensions) {
      const candidate = joinPath(directory, command + extension, windows);
      if (isFile(candidate) && accept(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Where Windows puts the OpenSSH tools when they are not on PATH.
 *
 * PATH is the right first answer, and the only one that finds a tool installed
 * somewhere unusual. But a desktop application is long-running: enabling the
 * OpenSSH client feature extends PATH for processes started *afterwards*, so an
 * app already open has a stale environment and would conclude that a machine
 * plainly holding ssh.exe does not have it. These are the locations worth
 * checking before saying that.
 */
function windowsOpenSshDirectories(env: NodeJS.ProcessEnv): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  return [
    joinPath(env.SystemRoot ?? 'C:\\Windows', 'System32\\OpenSSH', true),
    joinPath(programFiles, 'Git\\usr\\bin', true),
    joinPath(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git\\usr\\bin', true)
  ];
}

/**
 * Locate an OpenSSH command line tool as a path a pty can start.
 *
 * Shared by the terminal side (`ssh`) and the transfer side (`sftp`) so there is
 * one answer to "where is OpenSSH" rather than one per caller. An absolute path
 * is what matters: node-pty hands the file straight to CreateProcess on Windows,
 * which searches PATH but does not append `.exe`, so a bare `ssh` fails there on
 * a machine that has it.
 *
 * Returns undefined when the tool cannot be found, leaving the wording of that
 * failure to the caller, which knows what the user was trying to do.
 */
export function findOpenSshTool(command: 'ssh' | 'sftp', options: ShellCatalogOptions = {}): string | undefined {
  const onPath = findExecutable(command, options);
  if (onPath) return onPath;
  const { windows, env, isFile } = resolved(options);
  if (!windows) return undefined;
  for (const directory of windowsOpenSshDirectories(env)) {
    const candidate = joinPath(directory, `${command}.exe`, true);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Is this the `bash.exe` shim Windows installs for WSL?
 *
 * System32's bash.exe is present on every Windows 10 and 11 machine whether or
 * not a distribution is installed, and it launches WSL rather than Git Bash.
 * Offering it would mean a "Git Bash" entry that starts something else, or
 * nothing at all — and WSL already has its own backend. Rejecting it as a
 * candidate rather than abandoning the search lets Git for Windows' own
 * bash.exe, further along PATH, still be found.
 */
function isWslBashShim(file: string): boolean {
  return /[\\/]windows[\\/]system32[\\/]/i.test(file);
}

/** The shells worth offering on this platform, in the order they are preferred. */
function shellCandidates(windows: boolean): ShellCandidate[] {
  if (windows) {
    return [
      { backend: 'powershell', label: 'Windows PowerShell', command: 'powershell.exe' },
      { backend: 'pwsh', label: 'PowerShell 7', command: 'pwsh.exe' },
      { backend: 'cmd', label: 'Command Prompt', command: 'cmd.exe' },
      { backend: 'wsl', label: 'WSL', command: 'wsl.exe', args: wslStartArgs() },
      // Git for Windows ships bash; useful, but not a login shell for the OS.
      { backend: 'bash', label: 'Git Bash', command: 'bash.exe' }
    ];
  }
  return [
    { backend: 'bash', label: 'Bash', command: 'bash' },
    { backend: 'zsh', label: 'Zsh', command: 'zsh' },
    { backend: 'fish', label: 'Fish', command: 'fish' },
    { backend: 'sh', label: 'sh', command: 'sh' }
  ];
}

/**
 * Move the user's login shell to the front, and say so in its label.
 *
 * $SHELL is what the user chose for themselves, so it belongs first — but only
 * as an ordering: a login shell that is not one of the known backends is left
 * alone rather than spawned under a name the rest of the app cannot describe.
 */
function preferLoginShell(shells: ShellBackend[], loginShell: string | undefined): ShellBackend[] {
  if (!loginShell) return shells;
  const name = fileName(loginShell);
  const index = shells.findIndex((shell) => shell.backend === name);
  if (index <= 0) return shells;
  const preferred = { ...shells[index], label: `${shells[index].label} (login shell)` };
  return [preferred, ...shells.filter((_, position) => position !== index)];
}

/**
 * Every shell that exists on this machine, most preferred first.
 *
 * The first entry is the platform default: a native shell on Windows, the login
 * shell or bash on Unix.
 */
export function discoverShellBackends(options: ShellCatalogOptions = {}): ShellBackend[] {
  const context = resolved(options);
  const found: ShellBackend[] = [];
  for (const candidate of shellCandidates(context.windows)) {
    const skipShim = context.windows && candidate.backend === 'bash';
    const file = findExecutable(candidate.command, options, skipShim ? (match) => !isWslBashShim(match) : undefined);
    if (!file) continue;
    found.push({
      backend: candidate.backend,
      executable: file,
      args: candidate.args ?? [],
      label: candidate.label
    });
  }
  return context.windows ? found : preferLoginShell(found, context.loginShell);
}

/** The backend a new session gets when the caller names none. */
export function defaultShellBackend(options: ShellCatalogOptions = {}): ShellBackend {
  const shells = discoverShellBackends(options);
  if (!shells.length) throw new Error('No usable shell was found on PATH.');
  return shells[0];
}

/**
 * What to spawn for a requested backend.
 *
 * The backend name crosses the IPC boundary from the renderer, so it is looked
 * up in the catalogue rather than treated as a command: the renderer can name a
 * shell, never an executable. A backend that is not installed fails here, by
 * name, instead of as a pty that dies on spawn.
 */
export function resolveShellBackend(
  backend: LocalShellBackend,
  distribution?: string,
  options: ShellCatalogOptions = {}
): ShellBackend {
  const match = discoverShellBackends(options).find((shell) => shell.backend === backend);
  if (!match) {
    const label = shellCandidates(resolved(options).windows).find((candidate) => candidate.backend === backend)?.label ?? backend;
    throw new Error(`${label} is not installed or unavailable.`);
  }
  if (backend !== 'wsl' || !distribution) return match;

  const trimmed = distribution.trim();
  if (!WSL_DISTRIBUTION.test(trimmed)) {
    throw new Error('WSL distribution names may contain letters, numbers, spaces, _, ., and - only.');
  }
  return { ...match, args: ['-d', trimmed, ...wslStartArgs()], label: `WSL · ${trimmed}`, wslDistribution: trimmed };
}
