/**
 * Refuse URLs that point into the server's own network.
 *
 * The server sends requests to URLs users give it: a Pod URL, a WebID, an
 * identity provider, and the Pods a WebID profile lists. Left
 * unchecked, any signed-in user could aim those requests at services that
 * are only reachable from the server: localhost, the Docker network, a cloud
 * metadata address, the LAN.
 *
 * This resolves the hostname and rejects it if any address is not a public
 * one. createHostPolicy() applies it before every request a Solid session
 * sends, redirects included. The address is looked up again at connect
 * time, so a host whose DNS answer changes in between is not caught.
 */

import dns from 'node:dns/promises';
import net from 'node:net';

function isPublicIPv4(address) {
  const [a, b] = address.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return false;            // "this" network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false;            // carrier-grade NAT
  if (a === 169 && b === 254) return false;                      // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;             // private
  if (a === 192 && b === 168) return false;                      // private
  if (a === 192 && b === 0) return false;                        // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false;         // benchmarking
  if (a >= 224) return false;                                    // multicast, reserved, broadcast
  return true;
}

function isPublicIPv6(address) {
  const lower = address.toLowerCase().split('%')[0];
  if (lower === '::' || lower === '::1') return false;           // unspecified, loopback
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);    // IPv4-mapped
  if (mapped) return isPublicIPv4(mapped[1]);
  if (lower.startsWith('::ffff:')) return false;                 // IPv4-mapped, hex form
  if (/^f[cd]/.test(lower)) return false;                        // unique local fc00::/7
  if (/^fe[89ab]/.test(lower)) return false;                     // link-local fe80::/10
  if (lower.startsWith('ff')) return false;                      // multicast
  if (lower.startsWith('64:ff9b:')) return false;                // NAT64
  return true;
}

/** True for an IP address that is routable on the public internet. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

/**
 * @param {string} url
 * @param {{ lookup?: (hostname: string) => Promise<Array<{ address: string }>> }} [options]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function checkPublicUrl(url, options = {}) {
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (!hostname) return { ok: false, reason: 'no host' };

  if (net.isIP(hostname)) {
    return isPublicAddress(hostname) ? { ok: true } : { ok: false, reason: 'address is not public' };
  }

  const lookup = options.lookup ?? ((name) => dns.lookup(name, { all: true }));
  let addresses;
  try {
    addresses = await lookup(hostname);
  } catch {
    return { ok: false, reason: 'host could not be found' };
  }
  if (!addresses.length) return { ok: false, reason: 'host could not be found' };
  if (!addresses.every((entry) => isPublicAddress(entry.address))) {
    return { ok: false, reason: 'host resolves to an address that is not public' };
  }
  return { ok: true };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export class NonPublicHostError extends Error {
  constructor(url, reason) {
    super(`Request to a non-public address refused (${reason})`);
    this.name = 'NonPublicHostError';
    this.url = url;
  }
}

/**
 * Policy for the addresses the server may send a signed-in user's requests
 * to. Pod URLs, WebIDs and identity providers all come from users (or from
 * profiles they control), so each one is checked before the server fetches
 * it.
 *
 * @param {object} [options]
 * @param {boolean} [options.allowPrivate]  - Skip the check (ALLOW_PRIVATE_POD_HOSTS).
 * @param {string[]} [options.trustedUrls]  - Operator-configured URLs whose hosts are
 *   always allowed, e.g. the default identity provider on the local network.
 * @param {Function} [options.lookup]       - DNS lookup override (tests).
 * @param {number} [options.cacheMs]        - How long a host's result is reused.
 */
export function createHostPolicy(options = {}) {
  const { allowPrivate = false, trustedUrls = [], lookup, cacheMs = 60_000 } = options;
  const trustedHosts = new Set();
  for (const value of trustedUrls) {
    try { if (value) trustedHosts.add(new URL(value).host.toLowerCase()); } catch { /* ignore */ }
  }
  const cache = new Map(); // host -> { result, expires }

  /** @returns {Promise<{ ok: true } | { ok: false, reason: string }>} */
  async function check(url) {
    if (allowPrivate) return { ok: true };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'not a URL' };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, reason: 'not an http(s) URL' };
    }
    const host = parsed.host.toLowerCase();
    if (trustedHosts.has(host)) return { ok: true };
    const now = Date.now();
    const hit = cache.get(host);
    if (hit && hit.expires > now) return hit.result;
    const result = await checkPublicUrl(parsed.href, { lookup });
    if (cache.size > 1000) cache.clear();
    cache.set(host, { result, expires: now + cacheMs });
    return result;
  }

  async function isAllowed(url) {
    return (await check(url)).ok;
  }

  /** Keep only the URLs this policy allows, in order. */
  async function filterAllowed(urls) {
    const list = Array.isArray(urls) ? urls : [];
    const allowed = await Promise.all(list.map((u) => isAllowed(u)));
    return list.filter((_, i) => allowed[i]);
  }

  /**
   * Wrap a fetch so it refuses non-public addresses. Redirects are followed
   * here, one hop at a time, so a public host cannot bounce the request to a
   * private one.
   */
  function guardFetch(baseFetch) {
    if (allowPrivate) return baseFetch;
    return async function guardedFetch(input, init = {}) {
      const request = typeof input === 'object' && input !== null && 'url' in input && !(input instanceof URL) ? input : null;
      let url = request ? request.url : String(input);
      const redirectMode = init.redirect ?? request?.redirect ?? 'follow';
      let currentInput = input;
      let currentInit = init;

      for (let hop = 0; ; hop++) {
        const result = await check(url);
        if (!result.ok) throw new NonPublicHostError(url, result.reason);

        const response = await baseFetch(currentInput, { ...currentInit, redirect: 'manual' });
        const location = response.headers?.get?.('location');
        if (redirectMode !== 'follow' || !REDIRECT_STATUSES.has(response.status) || !location) {
          return response;
        }
        if (hop >= MAX_REDIRECTS) throw new TypeError('Too many redirects');

        const next = new URL(location, url).href;
        const method = (currentInit.method ?? request?.method ?? 'GET').toUpperCase();
        const dropBody = response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST');
        currentInit = { ...currentInit };
        if (dropBody) {
          currentInit.method = method === 'HEAD' ? 'HEAD' : 'GET';
          delete currentInit.body;
        }
        url = next;
        currentInput = next;
      }
    };
  }

  return { check, isAllowed, filterAllowed, guardFetch };
}
