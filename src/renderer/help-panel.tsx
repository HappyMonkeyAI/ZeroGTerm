// What the app does and what the keyboard does, in one place.
//
// The keyboard half is not written out here: it comes from the bindings in
// force, so the panel names the keys this copy of the app answers to, including
// ones the user has moved in Settings. Writing them out was how a tooltip came
// to advertise a chord for two releases with nothing bound to it, and a help
// panel is a far louder place to make that mistake.
//
// The features half is prose, and deliberately short. It is a reminder of what
// is here and where to click, not a manual; the README is the manual.

import React from 'react';
import { Icon } from './icons';
import { FOREIGN_CLAIMS, chordFor, shortcutRows, type Bindings } from './shortcuts';
import { versionLabel } from '../shared/version';

/** What a reader wants to be told exists, in the order they would meet it. */
const features = (bindings: Bindings): Array<{ title: string; body: string }> => [
  {
    title: 'Workspaces',
    body:
      'The boxes beside the wordmark are workspaces, each holding its own panes, layout, focused terminal and maximized pane. ' +
      'Switching to one restores the arrangement you left. They survive a relaunch: local terminals reattach, and SSH panes come back as ghost rows that reconnect when clicked.'
  },
  {
    title: 'Panes and layouts',
    body:
      'Up to four panes per workspace, as a stack, two splits, or a grid. Drag the dividers to resize, double-click one to even it up, and maximize a pane without losing the others.'
  },
  {
    title: 'Sessions',
    body:
      'Local shells — Bash, PowerShell, Command Prompt, WSL, Git Bash — and SSH hosts. Persistent sessions use screen where it is available, so a crash or a closed lid does not end the work. A WSL pane starts in the distribution’s own home directory.'
  },
  {
    title: 'The directory browser',
    body:
      'The folder button in a pane’s title bar splits that pane and lists where its shell is standing. Single-click to look, double-click to take the shell there. It works on SSH panes and local ones, WSL included, and follows a cd you type by hand.'
  },
  {
    title: 'Shared ports',
    body:
      'The Ports view on the rail forwards a port over SSH in either direction, VS Code style. Each tunnel is its own connection, so a host needs no terminal open first, and ports bind to loopback unless you widen them.'
  },
  {
    title: 'File transfer',
    body:
      'The ⇅ button above the panes opens SFTP for the active SSH session: this computer on the left, the host on the right, opening at the directory that shell is in. Upload, download, new folder, rename, delete.'
  },
  {
    title: 'Command history',
    body:
      `${chordFor('history-palette', bindings)} ranks the commands you have run by directory, host, recency, frequency and whether they worked. ` +
      'Off until you turn it on in Settings, and it refuses to store anything that looks like a credential.'
  },
  {
    title: 'AI suggestions and voice',
    body:
      'Ask for a command in plain words and approve it before it runs, using any OpenAI-compatible endpoint you point at in Settings. The microphone in a pane’s title bar types what you say into that terminal without running it.'
  },
  {
    title: 'The proceed button',
    body:
      'The tick in a pane’s title bar sends a phrase you choose — “OK, proceed” by default — for waving an agent on without typing the same reply again.'
  }
];

export function HelpPanel({
  version,
  bindings,
  onClose
}: {
  version: string | null;
  bindings: Bindings;
  onClose: () => void;
}) {
  // Named only when it is a chord this app currently answers to: a warning about
  // a key nothing here uses is trivia, and the point is to explain a shortcut
  // that appeared to do nothing.
  const contested = FOREIGN_CLAIMS.filter((claim) =>
    Object.values(bindings.chords).includes(claim.chord)
  );
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label="Help">
      <div className="help-card">
        <div className="modal-head">
          <div>
            <span className="eyebrow">HELP</span>
            <h2>{versionLabel(version)}</h2>
          </div>
          <button type="button" className="close-button" onClick={onClose}>Esc</button>
        </div>

        <div className="help-body">
          <section className="help-keys" aria-label="Keyboard shortcuts">
            <h3>Keyboard</h3>
            <table>
              <tbody>
                {shortcutRows(bindings).map((row) => (
                  <tr key={row.chord}>
                    <th scope="row"><kbd>{row.chord}</kbd></th>
                    <td>{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="help-note">
              <Icon name="info" />
              {/* The reason a chord can appear to do nothing, which is otherwise
                  indistinguishable from a bug in this app. */}
              <span>
                Only chords with Ctrl and Shift or Alt are claimed, so a shell keeps Ctrl+C, Ctrl+R, Ctrl+L and Ctrl+A
                for itself. If one of these does nothing, something outside ZeroG has taken it first — Windows uses
                Ctrl and Shift together to switch keyboard layout when more than one is installed
                {contested.length ? ', and ' : '. '}
                {contested.map((claim, index) => (
                  <React.Fragment key={claim.chord}>
                    {index > 0 ? '; ' : ''}
                    <kbd>{claim.chord}</kbd> is also {claim.owner}
                  </React.Fragment>
                ))}
                {contested.length ? '. ' : ''}
                Any of them can be moved in Settings, and every one has a button that does the same job.
              </span>
            </p>
          </section>

          <section className="help-features" aria-label="Features">
            <h3>What is here</h3>
            <dl>
              {features(bindings).map((feature) => (
                <React.Fragment key={feature.title}>
                  <dt>{feature.title}</dt>
                  <dd>{feature.body}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        </div>

        <small className="help-foot">
          The README covers all of this in more detail, including what is stored on this machine and what is refused.
        </small>
      </div>
    </div>
  );
}
