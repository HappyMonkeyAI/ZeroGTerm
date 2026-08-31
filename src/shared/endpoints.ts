// What counts as an endpoint ZeroG will make a request to, and what is worth
// saying about one before it is used.
//
// Shared rather than owned by the speech side because the AI suggestion path now
// asks the same three questions of the same kind of URL, and the answers must
// match: a settings panel that warns a key travels in the clear for one feature
// and not the other would be worse than either behaviour on its own.
//
// The host is the operator's choice — loopback, the LAN, or a hosted service —
// and nothing here refuses one on that basis. What is enforced is the shape: an
// http(s) URL with a host, so a typo or a file:// path cannot become a request.
// See SECURITY.md.

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** The endpoint as a URL, or null when it is not one a request can be made to. */
export function endpointOf(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // http and https are special schemes, so a missing host is a parse failure
    // rather than an empty hostname — every spelling of `http://` throws above.
    // The check is kept anyway: this is the one gate before a request is made,
    // and it should not rest on a parser detail holding everywhere.
    if (!parsed.hostname) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hostnameOf(url: string): string | null {
  const parsed = endpointOf(url);
  return parsed === null ? null : parsed.hostname.toLowerCase();
}

/**
 * Can a request be made to this URL?
 *
 * Any reachable host is allowed — loopback, LAN, or the public internet — but it
 * has to be an http(s) URL naming a host. A `file://` path, a `ws://` URL or a
 * half-typed address is refused here rather than turning into a request that
 * fails obscurely later.
 */
export function isSupportedEndpoint(url: string): boolean {
  return hostnameOf(url) !== null;
}

/**
 * Does this endpoint keep the payload on this machine?
 *
 * Nothing is refused on this basis; the settings panel uses it to say plainly
 * when recorded speech or terminal output is about to leave the machine.
 * `*.localhost` resolves to loopback by specification, so it counts.
 */
export function isLoopbackEndpoint(url: string): boolean {
  const hostname = hostnameOf(url);
  if (hostname === null) return false;
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * Would a key sent to this endpoint travel in the clear?
 *
 * True for plain http to anywhere but this machine. Nothing is blocked on this
 * basis — a self-hosted server on the LAN commonly has no certificate, and
 * refusing to authenticate to it would break the ordinary case — but it is worth
 * saying out loud next to the field where the key is typed.
 */
export function sendsKeyInClear(url: string): boolean {
  const parsed = endpointOf(url);
  if (parsed === null) return false;
  return parsed.protocol === 'http:' && !isLoopbackEndpoint(url);
}
