import type { BackdropDismissHandlers } from './backdrop-dismiss';
import type { UpdateState } from '../shared/update';
import { updatePromptBody } from './update-view';

export type UpdatePromptProps = {
  state: Extract<UpdateState, { status: 'available' | 'downloading' | 'ready' }>;
  backdrop: BackdropDismissHandlers;
  onDownload: () => void;
  onInstall: () => void;
  onOpenRelease: () => void;
  /** Close for now; the popup returns on a later launch. */
  onLater: () => void;
  /** Never mention this version again. */
  onSkip: () => void;
};

/**
 * The popup shown when a newer release exists.
 *
 * The release notes are not rendered: they are remote text, and the release
 * page shows them properly. The version number and a link are enough to decide.
 */
export function UpdatePrompt({ state, backdrop, onDownload, onInstall, onOpenRelease, onLater, onSkip }: UpdatePromptProps) {
  const installable = state.mode === 'install';
  return (
    <div className="modal-layer" role="presentation" {...backdrop}>
      <div className="modal-card update-card" role="dialog" aria-modal="true" aria-labelledby="update-prompt-title">
        <div className="modal-head">
          <div>
            <span className="eyebrow">UPDATE</span>
            <h2 id="update-prompt-title">
              {state.status === 'ready' ? `Version ${state.version} is ready` : `Version ${state.version} is available`}
            </h2>
          </div>
          <button type="button" className="close-button" onClick={onLater}>Esc</button>
        </div>
        <p>
          You have v{state.currentVersion}. {updatePromptBody(state)}
        </p>
        {state.status === 'downloading' && (
          <div className="update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.percent}>
            <span style={{ width: `${state.percent}%` }} />
          </div>
        )}
        <button type="button" className="dialog-disclosure" onClick={onOpenRelease}>What’s new in {state.version}</button>
        <div className="modal-actions">
          {state.status === 'available' && <button type="button" onClick={onSkip}>Skip this version</button>}
          <button type="button" onClick={onLater}>Later</button>
          {state.status === 'ready' ? (
            <button type="button" className="primary-button" autoFocus onClick={onInstall}>Restart &amp; install</button>
          ) : state.status === 'downloading' ? (
            <button type="button" className="primary-button" disabled>Downloading… {state.percent}%</button>
          ) : installable ? (
            <button type="button" className="primary-button" autoFocus onClick={onDownload}>Download &amp; install</button>
          ) : (
            <button type="button" className="primary-button" autoFocus onClick={onOpenRelease}>Open download page</button>
          )}
        </div>
      </div>
    </div>
  );
}
