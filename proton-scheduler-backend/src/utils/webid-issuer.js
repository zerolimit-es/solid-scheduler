/**
 * WebID ↔ OIDC issuer binding check (Solid-OIDC §"OIDC Issuer Discovery").
 *
 * An ID token proves only that *its issuer* vouches for the `webid` claim.
 * Anyone can run an OIDC provider and mint a token claiming any WebID, so a
 * relying party must also confirm that the WebID's own profile document
 * names that issuer via `solid:oidcIssuer`. Without this check, any user of
 * the instance (including its operator) can be impersonated.
 */

import { getSolidDataset, getThing, getUrlAll } from '@inrupt/solid-client';

export const SOLID_OIDC_ISSUER = 'http://www.w3.org/ns/solid/terms#oidcIssuer';

const PROFILE_FETCH_TIMEOUT_MS = 10_000;

/** Canonical form of an issuer URL for comparison, or null if invalid. */
export function normalizeIssuer(value) {
  if (typeof value !== 'string' || value === '') return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/+$/, '');
}

/**
 * Read the issuers a WebID profile trusts.
 *
 * The profile is fetched *unauthenticated*: Solid-OIDC requires these triples
 * to be public, and the session's authenticated fetch must not be used here
 * because its token is exactly what is being checked.
 *
 * @param {string} webId
 * @param {{ fetch?: typeof globalThis.fetch }} [options]
 * @returns {Promise<string[]>}
 */
export async function getTrustedIssuers(webId, options = {}) {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const fetchWithTimeout = (input, init = {}) =>
    baseFetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS) });

  const profileUrl = new URL(webId);
  profileUrl.hash = '';
  const dataset = await getSolidDataset(profileUrl.href, { fetch: fetchWithTimeout });
  const profile = getThing(dataset, webId);
  if (!profile) return [];
  return getUrlAll(profile, SOLID_OIDC_ISSUER);
}

/**
 * Check that `webId`'s public profile lists `issuer` as a solid:oidcIssuer.
 * Never throws: any failure (bad input, network error, unparsable profile)
 * returns `{ ok: false }` so callers fail closed.
 *
 * @param {string} webId
 * @param {string} issuer - The issuer the login flow was started against.
 * @param {{ fetch?: typeof globalThis.fetch }} [options]
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function verifyWebIdIssuer(webId, issuer, options = {}) {
  const wanted = normalizeIssuer(issuer);
  if (!wanted) return { ok: false, reason: 'missing or invalid issuer' };

  try {
    const parsed = new URL(webId);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, reason: 'WebID is not an http(s) URL' };
    }
  } catch {
    return { ok: false, reason: 'invalid WebID' };
  }

  let trusted;
  try {
    trusted = await getTrustedIssuers(webId, options);
  } catch (err) {
    return { ok: false, reason: `could not read WebID profile: ${err.message}` };
  }

  if (trusted.some((t) => normalizeIssuer(t) === wanted)) {
    return { ok: true };
  }
  return { ok: false, reason: 'issuer is not listed as solid:oidcIssuer in the WebID profile' };
}
