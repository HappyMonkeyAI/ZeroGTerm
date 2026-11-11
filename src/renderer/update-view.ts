// Words for the update popup and the Settings → Updates page.
//
// Pure, so what each state says can be tested without rendering anything.

import type { UpdateState } from '../shared/update';

/** One line describing where the update check stands, for Settings. */
export function updateSummary(state: UpdateState | null): string {
  if (!state) return 'Update status is not available.';
  if (state.mode === 'disabled') return 'Update checks are off in a development or npm-installed build.';
  switch (state.status) {
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      return `You have the latest version (v${state.currentVersion}).`;
    case 'available':
      return `Version ${state.version} is available.`;
    case 'downloading':
      return `Downloading version ${state.version}… ${state.percent}%`;
    case 'ready':
      return `Version ${state.version} is downloaded and will install when ZeroG restarts.`;
    case 'error':
      return `The update check failed: ${state.message}`;
  }
}

/** What the popup's body says, by what this build can do. */
export function updatePromptBody(state: UpdateState): string {
  if (state.status === 'ready') {
    return 'The update is downloaded. Restarting closes every pane: local shells end, SSH connections drop, and screen sessions keep running to reattach.';
  }
  if (state.status === 'downloading') return 'Downloading the update. You can keep working while it finishes.';
  if (state.mode === 'install') {
    return 'ZeroG can download it now and restart into it when you are ready. Nothing installs until you say so.';
  }
  // Either a build that cannot replace itself (the portable .exe, the .deb),
  // or a release the installer could not read; the release page serves both.
  return 'Download the new version from its release page.';
}
