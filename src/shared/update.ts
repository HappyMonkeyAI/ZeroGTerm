// What the app knows about a newer release, and what it can do about one.
//
// Kept pure and free of Electron so the rules can be tested directly. The main
// process owns the network and the installer; the renderer only ever sees an
// UpdateState and asks for one of the three actions.
//
// Two ways to update exist because not every build can replace itself:
//
// - `install`: the Windows installer (NSIS) and the AppImage. electron-updater
//   downloads the new build, checks it against the release's latest*.yml, and
//   swaps it in on restart.
// - `notify`: the portable .exe and the .deb. Neither can be replaced in place
//   by the app (the portable runs from wherever it was saved, and a .deb belongs
//   to the package manager), so the newest release is looked up and the user is
//   sent to its page.
//
// An unpackaged run — `npm run dev`, or the npm-installed CLI — checks nothing:
// its version is the working tree's, and a prompt there would be noise.

/** The release page every link handed to the browser must sit under. */
export const RELEASES_URL = 'https://github.com/HappyMonkeyAI/ZeroGTerm/releases';
/** GitHub's answer for the newest non-draft, non-prerelease release. */
export const LATEST_RELEASE_API = 'https://api.github.com/repos/HappyMonkeyAI/ZeroGTerm/releases/latest';

export type UpdateMode = 'install' | 'notify' | 'disabled';

export type UpdateState =
  | { status: 'idle'; mode: UpdateMode; currentVersion: string }
  | { status: 'checking'; mode: UpdateMode; currentVersion: string }
  | { status: 'current'; mode: UpdateMode; currentVersion: string; checkedAt: number }
  | { status: 'available'; mode: UpdateMode; currentVersion: string; version: string; releaseUrl: string }
  | { status: 'downloading'; mode: UpdateMode; currentVersion: string; version: string; releaseUrl: string; percent: number }
  | { status: 'ready'; mode: UpdateMode; currentVersion: string; version: string; releaseUrl: string }
  | { status: 'error'; mode: UpdateMode; currentVersion: string; message: string };

export type UpdateStatus = UpdateState['status'];

/**
 * How this build can update, from facts the main process has to hand.
 *
 * `env` is passed rather than read so the decision can be tested. electron-builder's
 * portable launcher sets PORTABLE_EXECUTABLE_FILE before starting the app, and the
 * AppImage runtime sets APPIMAGE; neither is present in an NSIS install or a .deb.
 */
export function updateMode(input: { isPackaged: boolean; platform: NodeJS.Platform | string; env: Record<string, string | undefined> }): UpdateMode {
  if (!input.isPackaged) return 'disabled';
  if (input.platform === 'win32') return input.env.PORTABLE_EXECUTABLE_FILE ? 'notify' : 'install';
  if (input.platform === 'linux') return input.env.APPIMAGE ? 'install' : 'notify';
  // macOS is not built, and an unsigned mac app cannot update itself anyway.
  return 'notify';
}

type ParsedVersion = { core: [number, number, number]; pre: string[] };

/** Semver-ish parse: `v1.2.3`, `1.2.3-beta.1`. Build metadata is ignored. Null if it is not a version. */
export function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== 'string') return null;
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/.exec(raw.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : []
  };
}

/**
 * Compare two versions: negative if `a` is older, positive if newer, 0 if equal.
 * Unparseable input compares as equal, so it can never cause a prompt.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    const diff = left.core[index] - right.core[index];
    if (diff) return Math.sign(diff);
  }
  // A release outranks any prerelease of the same version.
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index];
    const y = right.pre[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff) return Math.sign(diff);
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Is `candidate` newer than what is running? */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * Accept a release page URL only if it is one of this project's releases.
 *
 * The URL comes back from the network, so it is not trusted to be what it says:
 * it is re-parsed and must be https on github.com under the project's releases
 * path. Anything else falls back to the releases index.
 */
export function safeReleaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) return RELEASES_URL;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return RELEASES_URL;
  }
  const allowed = new URL(RELEASES_URL);
  if (parsed.protocol !== 'https:' || parsed.host !== allowed.host) return RELEASES_URL;
  if (parsed.pathname !== allowed.pathname && !parsed.pathname.startsWith(`${allowed.pathname}/`)) return RELEASES_URL;
  if (parsed.username || parsed.password) return RELEASES_URL;
  // Only the page itself: a query or fragment from the network is not needed
  // to show a release, so none is passed on to the browser.
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

/** The release page for a version, built rather than taken from a response. */
export function releaseUrlFor(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed) return RELEASES_URL;
  return `${RELEASES_URL}/tag/v${encodeURIComponent(version.replace(/^v/, ''))}`;
}

/**
 * Read GitHub's latest-release answer. Only the tag and the page are used; the
 * body is release notes written for people, and is never rendered here.
 */
export function parseLatestRelease(json: unknown): { version: string; releaseUrl: string } | null {
  if (!json || typeof json !== 'object') return null;
  const record = json as Record<string, unknown>;
  if (record.draft === true || record.prerelease === true) return null;
  const parsed = parseVersion(record.tag_name);
  if (!parsed) return null;
  const version = String(record.tag_name).trim().replace(/^v/, '');
  return { version, releaseUrl: safeReleaseUrl(record.html_url) };
}

/**
 * Should the popup be showing, given what the user already turned down?
 *
 * `asked` is true after a check the user started from Settings: they asked, so
 * the answer is shown even for a version they skipped or put off.
 */
export function shouldPrompt(state: UpdateState | null, skippedVersion: string, dismissedVersion: string | null, asked = false): boolean {
  if (!state) return false;
  if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'ready') return false;
  if (asked) return true;
  if (state.version === skippedVersion) return false;
  if (state.version === dismissedVersion) return false;
  return true;
}
