import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatVersion, versionLabel } from '../src/shared/version';

describe('formatVersion', () => {
  it('shows the version exactly as the app reports it', () => {
    // Not shortened to 0.7-alpha or similar: the whole reason for reading it
    // from the running app is that it cannot disagree with the build.
    expect(formatVersion('0.7.0-alpha3')).toBe('v0.7.0-alpha3');
    expect(formatVersion('1.0.0')).toBe('v1.0.0');
    expect(formatVersion('0.8.0-alpha1+build.7')).toBe('v0.8.0-alpha1+build.7');
  });

  it('does not double a v the version already carries', () => {
    expect(formatVersion('v1.2.3')).toBe('v1.2.3');
  });

  it('trims what it is given', () => {
    expect(formatVersion('  0.7.0-alpha3\n')).toBe('v0.7.0-alpha3');
  });

  it('shows nothing rather than a placeholder', () => {
    // An older preload has no version channel, and a main process that answers
    // oddly should leave the title bar as it was.
    expect(formatVersion(undefined)).toBeNull();
    expect(formatVersion(null)).toBeNull();
    expect(formatVersion('')).toBeNull();
    expect(formatVersion('   ')).toBeNull();
    expect(formatVersion(42 as unknown as string)).toBeNull();
    expect(formatVersion('x'.repeat(200))).toBeNull();
  });
});

describe('versionLabel', () => {
  it('names the app and the version', () => {
    expect(versionLabel('0.7.0-alpha3')).toBe('ZeroG Terminal v0.7.0-alpha3');
  });

  it('falls back to the name alone', () => {
    expect(versionLabel(null)).toBe('ZeroG Terminal');
  });
});

/**
 * The version is written down in three places, and the title bar now shows one
 * of them to every user.
 *
 * package.json is the source: Electron reports it, so it is what the app says
 * about itself. These check that the two places a human reads instead — the
 * release line in the README and the history in versions.txt — have not been
 * left behind by a bump, which is exactly what happened between alpha2 and
 * alpha3 while five features landed.
 */
describe('the version written down', () => {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

  it('is a version the app can show', () => {
    expect(formatVersion(pkg.version)).toBe(`v${pkg.version}`);
  });

  it('has an entry in versions.txt', () => {
    const history = readFileSync(join(root, 'versions.txt'), 'utf8');
    const entries = history
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+\.\d+\.\d+/.test(line));
    expect(entries.length).toBeGreaterThan(0);
    const described = entries.some((line) => line.startsWith(`${pkg.version} - `));
    expect(described, `versions.txt has no entry for ${pkg.version}`).toBe(true);
    // And it is the newest entry, so the history reads in release order.
    expect(entries[entries.length - 1].startsWith(`${pkg.version} - `)).toBe(true);
  });

  it('is the release the README names', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    expect(readme, `the README does not name ${pkg.version} as the current release`)
      .toContain(`The current release is \`${pkg.version}\``);
  });

  it('has a lockfile that agrees', () => {
    // npm rewrites both entries on install; a hand-edited bump can miss them,
    // and then a packaged build reports something nobody chose.
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });
});
