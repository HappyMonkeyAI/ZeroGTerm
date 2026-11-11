// Checking for, downloading and installing a newer release.
//
// Nothing happens on its own: the renderer asks for a check (at startup, when
// the setting allows it, or from Settings), and a download only starts when the
// user says so in the popup. That keeps the app from reaching out or replacing
// itself without consent, and keeps the policy — when to check, which version
// was skipped — in the renderer's settings where the user can see it.
//
// The installer is behind a small interface rather than imported directly, so
// the service can be tested with a fake and electron-updater is only loaded in a
// build that can actually use it.

import {
  type UpdateMode,
  type UpdateState,
  isNewer,
  parseLatestRelease,
  releaseUrlFor
} from '../shared/update.js';

/** The part of electron-updater's AppUpdater this uses. */
export type InstallUpdater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
};

export type UpdateServiceOptions = {
  mode: UpdateMode;
  currentVersion: string;
  /** Loads electron-updater; only called in `install` mode. */
  loadUpdater?: () => Promise<InstallUpdater>;
  /** GitHub's latest-release JSON; used in `notify` mode. */
  fetchLatest: () => Promise<unknown>;
  onChange: (state: UpdateState) => void;
};

/** An error from the network can carry a whole HTML page; keep one short line. */
export function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!line) return 'The update check failed.';
  return line.length > 200 ? `${line.slice(0, 197)}…` : line;
}

export class UpdateService {
  private state: UpdateState;
  private updater: InstallUpdater | null = null;

  constructor(private readonly options: UpdateServiceOptions) {
    this.state = { status: 'idle', mode: options.mode, currentVersion: options.currentVersion };
  }

  current(): UpdateState {
    return this.state;
  }

  private set(state: UpdateState): UpdateState {
    this.state = state;
    this.options.onChange(state);
    return state;
  }

  private base() {
    return { mode: this.options.mode, currentVersion: this.options.currentVersion };
  }

  private async installer(): Promise<InstallUpdater> {
    if (this.updater) return this.updater;
    if (!this.options.loadUpdater) throw new Error('This build cannot install updates.');
    const updater = await this.options.loadUpdater();
    // Downloading is the user's call, made in the popup.
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.on('download-progress', (progress) => {
      if (this.state.status !== 'downloading') return;
      const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)));
      if (percent !== this.state.percent) this.set({ ...this.state, percent });
    });
    this.updater = updater;
    return updater;
  }

  /** Look for a newer release. A check already under way, or a download, is left alone. */
  async check(): Promise<UpdateState> {
    const { mode } = this.options;
    if (mode === 'disabled') return this.state;
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'ready') {
      return this.state;
    }
    this.set({ status: 'checking', ...this.base() });
    if (mode === 'install') {
      try {
        const updater = await this.installer();
        const result = await updater.checkForUpdates();
        const version = result?.updateInfo?.version;
        if (typeof version === 'string' && isNewer(version, this.options.currentVersion)) {
          return this.set({ status: 'available', ...this.base(), version, releaseUrl: releaseUrlFor(version) });
        }
        return this.set({ status: 'current', ...this.base(), checkedAt: Date.now() });
      } catch (error) {
        // A release published without its update manifest (latest.yml), or one
        // the installer cannot read, should still be announced: fall back to
        // the release page, and offer the download link instead of an install.
        const fallback = await this.lookUpRelease();
        if (fallback.status === 'available') return this.set({ ...fallback, mode: 'notify' });
        return this.set({ status: 'error', ...this.base(), message: shortError(error) });
      }
    }
    return this.set(await this.lookUpRelease());
  }

  /** Ask GitHub for the newest release, without installing anything. */
  private async lookUpRelease(): Promise<UpdateState> {
    try {
      const latest = parseLatestRelease(await this.options.fetchLatest());
      if (latest && isNewer(latest.version, this.options.currentVersion)) {
        return { status: 'available', ...this.base(), ...latest };
      }
      return { status: 'current', ...this.base(), checkedAt: Date.now() };
    } catch (error) {
      return { status: 'error', ...this.base(), message: shortError(error) };
    }
  }

  /** Fetch the update the last check found. Only an installable build can. */
  async download(): Promise<UpdateState> {
    // The state's own mode, not the build's: a release found through the
    // fallback lookup has no manifest to download against.
    if (this.state.status !== 'available' || this.state.mode !== 'install') return this.state;
    const { version, releaseUrl } = this.state;
    this.set({ status: 'downloading', ...this.base(), version, releaseUrl, percent: 0 });
    try {
      const updater = await this.installer();
      await updater.downloadUpdate();
      return this.set({ status: 'ready', ...this.base(), version, releaseUrl });
    } catch (error) {
      return this.set({ status: 'error', ...this.base(), message: shortError(error) });
    }
  }

  /** Restart into the downloaded update. */
  install(): void {
    if (this.state.status !== 'ready' || !this.updater) return;
    this.updater.quitAndInstall(false, true);
  }
}
