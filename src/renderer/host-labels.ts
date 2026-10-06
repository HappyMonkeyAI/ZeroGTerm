// Which session label goes with which host.
//
// Kept apart from the dialog so the rules — what counts as the same host, what
// is worth remembering — can be tested without rendering one.

import type { StoredHostLabelFile } from '../shared/types';
import { normalizeHost } from './remote-screens';

/**
 * What a target is remembered under: the host alone, lowercased.
 *
 * Not the user or port. Someone who connects to one machine as two users still
 * thinks of it as "web server", and the label is a name for the machine. The
 * host is what the user said they wanted it recorded against.
 */
export function hostLabelKey(target: string): string {
  return normalizeHost(target.trim()).toLowerCase();
}

/** The label last used for this target, if there is one. */
export function labelFor(file: StoredHostLabelFile, target: string): string | undefined {
  const key = hostLabelKey(target);
  if (!key) return undefined;
  return file.hosts.find((entry) => entry.host === key)?.label;
}

/**
 * The file after a connect with this label.
 *
 * A blank label leaves the file as it was: connecting without one is not the
 * same as asking to forget the old one. The host moves to the end so the store's
 * cap drops whichever has gone longest unused.
 */
export function withLabel(file: StoredHostLabelFile, target: string, label: string): StoredHostLabelFile {
  const key = hostLabelKey(target);
  const text = label.trim();
  if (!key || !text) return file;
  if (labelFor(file, target) === text && file.hosts[file.hosts.length - 1]?.host === key) return file;
  return { version: file.version, hosts: [...file.hosts.filter((entry) => entry.host !== key), { host: key, label: text }] };
}

export const EMPTY_HOST_LABELS: StoredHostLabelFile = { version: 1, hosts: [] };
