// How shared ports read in the sidebar, and which of them can coexist.
//
// Kept out of main.tsx so the rules can be unit tested — main.tsx calls
// createRoot at module scope and cannot be imported from a test — and so that
// "is this port already taken" is answered in one place, on both sides of the
// IPC boundary, rather than only where a process would fail.

import type { PortForwardInfo, PortForwardRequest, StoredPortForwardFile } from '../shared/types';
import { normalizeHost } from './remote-screens';

/** A host and the tunnels it holds, for the grouped list. */
export type ForwardGroup = {
  host: string;
  forwards: PortForwardInfo[];
};

/**
 * Group tunnels by the host they run through.
 *
 * Grouped on the bare hostname so `dev@build.example.com:2222` and
 * `build.example.com` are one heading rather than two, matching how the Screens
 * tab already groups. Hosts are ordered by first appearance so the list does not
 * reshuffle as a tunnel opens.
 */
export function groupForwards(forwards: PortForwardInfo[]): ForwardGroup[] {
  const groups = new Map<string, ForwardGroup>();
  for (const forward of forwards) {
    const host = normalizeHost(forward.target) || forward.target;
    const group = groups.get(host) ?? { host, forwards: [] };
    group.forwards.push(forward);
    groups.set(host, group);
  }
  return [...groups.values()];
}

/** The `.status-dot` modifier for a tunnel, reusing the session vocabulary. */
export function forwardDotState(forward: PortForwardInfo): 'connected' | 'detached' | 'error' | '' {
  if (forward.status === 'open') return 'connected';
  if (forward.status === 'error') return 'error';
  if (forward.status === 'connecting') return 'detached';
  return '';
}

/**
 * The two ends of a tunnel, in the direction traffic travels.
 *
 * The arrow is the whole point: a row has to say which side listens and which
 * side answers, because the two directions are otherwise indistinguishable and
 * getting them the wrong way round is the easiest mistake to make here.
 */
export function forwardLabel(forward: PortForwardRequest): string {
  const destination = `${forward.destinationHost || 'localhost'}:${forward.destinationPort}`;
  return forward.direction === 'local'
    ? `${listenerLabel(forward)} → ${destination}`
    : `${listenerLabel(forward)} → ${destination} here`;
}

/** Where the listening socket actually is, from the user's point of view. */
export function listenerLabel(forward: PortForwardRequest): string {
  if (forward.direction === 'local') {
    return `${forward.bind === 'all' ? '0.0.0.0' : 'localhost'}:${forward.listenPort}`;
  }
  const host = normalizeHost(forward.target) || forward.target;
  return `${forward.bind === 'all' ? `${host} (all)` : host}:${forward.listenPort}`;
}

/**
 * Is this forward exposed beyond the machine that binds it?
 *
 * Surfaced as its own question because the row has to say so plainly: a wide
 * bind re-exports someone else's service onto whatever network that machine is
 * attached to, and it should never be something the user has to work out.
 */
export function isWidelyBound(forward: PortForwardRequest): boolean {
  return forward.bind === 'all';
}

/**
 * Why this forward cannot be opened alongside the ones already there, if it
 * cannot.
 *
 * The service refuses the same clashes, since it is the only thing that can be
 * sure; this exists so the dialog can say so before spawning a client, and so
 * the sentence is the same either way. A local forward binds on this machine, so
 * its port clashes with any other local one; a remote forward binds on the far
 * host, so it clashes only with another on that same host.
 */
export function forwardConflict(request: PortForwardRequest, existing: PortForwardInfo[]): string | null {
  const clash = existing.find((candidate) => {
    if (candidate.id === request.id) return false;
    if (candidate.listenPort !== request.listenPort) return false;
    if (candidate.direction !== request.direction) return false;
    if (request.direction === 'local') return true;
    return normalizeHost(candidate.target) === normalizeHost(request.target);
  });
  if (!clash) return null;
  return request.direction === 'local'
    ? `Port ${request.listenPort} is already shared from ${clash.target}.`
    : `Port ${request.listenPort} is already shared to ${clash.target}.`;
}

/**
 * Merge a status update into the list.
 *
 * Replaces by id rather than appending, because a tunnel reports itself several
 * times on the way up and each report describes the same row.
 */
export function applyForwardStatus(forwards: PortForwardInfo[], updated: PortForwardInfo): PortForwardInfo[] {
  const index = forwards.findIndex((forward) => forward.id === updated.id);
  if (index < 0) return [...forwards, updated];
  const next = [...forwards];
  next[index] = updated;
  return next;
}

/**
 * Everything worth remembering, with its status dropped.
 *
 * A status is a fact about now, not about the next launch: a tunnel is saved so
 * it can be offered again, and it comes back idle whatever it was doing when the
 * app closed. Forwards that never opened are saved too — the user asked for
 * them, and a host being down tonight is not a reason to forget by morning.
 */
export function toStoredForwards(forwards: PortForwardInfo[]): StoredPortForwardFile {
  return {
    version: 1,
    forwards: forwards.map(({ status, message, ...rest }) => rest)
  };
}

/** Restored tunnels, idle until the user asks for one. */
export function fromStoredForwards(file: StoredPortForwardFile): PortForwardInfo[] {
  return file.forwards.map((forward) => ({ ...forward, status: 'idle' as const }));
}
