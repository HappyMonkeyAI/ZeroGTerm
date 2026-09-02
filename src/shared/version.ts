// How the running version is shown.
//
// The version comes from Electron's own reading of package.json, so what the
// title bar says is what is actually running — including in a packaged build,
// where a string compiled in from the repo could be a release behind. Nothing
// here invents or shortens a version: the point of reading it from the app is
// that it cannot drift, and a prettified form would be a second version string
// to keep in step.

/** How long a version string may plausibly be before it is not one. */
const MAX_LENGTH = 40;

/**
 * The version as the title bar shows it, or null when there is nothing to show.
 *
 * Null rather than a placeholder: an older preload with no version channel, or a
 * main process that answered oddly, should leave the title as it was rather than
 * putting "vunknown" beside the name.
 */
export function formatVersion(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LENGTH) return null;
  // A leading `v` is presentation, so it is added if package.json omitted it and
  // not doubled if it did not.
  return trimmed.startsWith('v') || trimmed.startsWith('V') ? trimmed : `v${trimmed}`;
}

/** The full name and version, for the tooltip on the wordmark. */
export function versionLabel(raw: string | null | undefined): string {
  const version = formatVersion(raw);
  return version ? `ZeroG Terminal ${version}` : 'ZeroG Terminal';
}
