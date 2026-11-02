/**
 * Launch hints for opening a local shell in a given directory.
 *
 * FileMan (and CLI callers) pass the path as `--cwd <dir>`, a bare absolute
 * argv element, and/or `ZEROG_OPEN_CWD` in the environment. Prefer the flag,
 * then the env var, then the last absolute-looking positional argument.
 */

export function looksLikeAbsolutePath(value: string): boolean {
  if (!value || value.startsWith('-')) return false;
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith('\\\\') || value.startsWith('/')) return true;
  return false;
}

function isLauncherNoise(arg: string): boolean {
  if (arg === '.' || arg === '..') return true;
  if (/\.(exe|app|asar)$/i.test(arg)) return true;
  if (/[/\\]electron([/\\.]|$)/i.test(arg)) return true;
  return false;
}

/**
 * Extract an open-cwd hint from process argv + env.
 *
 * Does not resolve or verify the path — callers validate with resolveLocalPath
 * (or equivalent) before spawning a shell there.
 */
export function parseOpenCwd(
  argv: readonly string[],
  env: Record<string, string | undefined> = {}
): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cwd' || arg === '-C') {
      const next = argv[i + 1];
      if (typeof next === 'string' && next && !next.startsWith('-')) {
        const trimmed = next.trim();
        return trimmed || null;
      }
      continue;
    }
    if (arg.startsWith('--cwd=')) {
      const trimmed = arg.slice('--cwd='.length).trim();
      if (trimmed) return trimmed;
    }
  }

  const fromEnv = (env.ZEROG_OPEN_CWD ?? '').trim();
  if (fromEnv) return fromEnv;

  for (let i = argv.length - 1; i >= 0; i -= 1) {
    const arg = argv[i];
    if (!looksLikeAbsolutePath(arg) || isLauncherNoise(arg)) continue;
    return arg;
  }

  return null;
}

/** Session title derived from a directory path (screen-safe charset). */
export function sessionNameForCwd(cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? 'local';
  const safe = base.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return safe || 'local';
}
