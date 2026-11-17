/**
 * Refuse URLs that point into the server's own network.
 *
 * The server sends requests to URLs users give it (a Pod URL). Left
 * unchecked, any signed-in user could aim those requests at services that
 * are only reachable from the server: localhost, the Docker network, a cloud
 * metadata address, the LAN.
 *
 * This resolves the hostname and rejects it if any address is not a public
 * one. It is a check at the time the URL is saved; it does not pin the
 * address for later requests.
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
