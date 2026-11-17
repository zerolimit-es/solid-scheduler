/**
 * Pod selection helpers.
 *
 * Routes accept an optional `?pod=` query parameter so a user with several
 * Pods can pick one. That value is attacker-controllable (any cross-site
 * link can set it), and the server sends the user's *authenticated* Solid
 * requests to whatever Pod URL it resolves to. Accepting it as-is would let
 * anyone point those requests at an arbitrary host (SSRF) or swap in
 * attacker-controlled Pod data. So `?pod=` is only honoured when it is one of
 * the signed-in user's own Pods.
 */

export class PodNotAllowedError extends Error {
  constructor() {
    super('Requested Pod is not one of your Pods');
    this.name = 'PodNotAllowedError';
    this.status = 400;
  }
}

/** Canonical form of a Pod URL for comparison, or null if it is not http(s). */
export function normalizePodUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/**
 * Choose the Pod to use for a request.
 *
 * @param {unknown} requested - The raw `?pod=` value (may be undefined).
 * @param {string[]} pods     - The signed-in user's own Pods.
 * @returns {string|undefined} The requested Pod when it is one of `pods`,
 *   otherwise `pods[0]` when nothing was requested.
 * @throws {PodNotAllowedError} When a Pod was requested that is not the user's.
 */
export function selectPod(requested, pods) {
  const ownPods = Array.isArray(pods) ? pods.filter(Boolean) : [];
  if (requested === undefined || requested === null || requested === '') {
    return ownPods[0];
  }
  const wanted = normalizePodUrl(requested);
  if (wanted) {
    const match = ownPods.find((p) => normalizePodUrl(p) === wanted);
    if (match) return match;
  }
  throw new PodNotAllowedError();
}
