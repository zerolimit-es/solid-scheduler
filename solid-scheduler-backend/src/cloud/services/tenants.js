/**
 * Tenant provisioning for signed-in Solid users.
 *
 * Every signed-in WebID maps to one tenant row. Routes key per-account state
 * on it: booking slug, passkeys, calendar events, feed tokens, usage. This
 * module is the single place that finds or creates that row.
 */

import * as db from '../models/database.js';
import { extractSlug } from '../../utils/webid.js';

/** Normalise a user-chosen booking slug the same way the availability route does. */
export function normalizeSlug(value) {
  if (typeof value !== 'string') return null;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || null;
}

/** `base`, or `base-xxxx` when `isTaken(base)`, retrying a few random suffixes. */
function firstFree(base, isTaken) {
  if (!isTaken(base)) return base;
  for (let i = 0; i < 10; i++) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`Could not find a free value for "${base}"`);
}

/**
 * Find the tenant for `webId`, creating it on first sign-in.
 *
 * @param {string} webId
 * @param {object} [options]
 * @param {string|null} [options.podUrl]        Stored on a newly created tenant.
 * @param {string|null} [options.preferredSlug] Booking slug to claim for a new
 *   tenant, typically the `bookingSlug` from the user's own Pod availability,
 *   so an existing install keeps its booking page and bookings. Used only if
 *   no other tenant holds it; otherwise a slug is derived from the WebID.
 * @returns {{ tenant: object, created: boolean }}
 */
export function ensureTenant(webId, { podUrl = null, preferredSlug = null } = {}) {
  if (typeof webId !== 'string' || !webId) {
    throw new Error('ensureTenant requires a WebID');
  }

  const existing = db.getTenantByWebId(webId);
  if (existing) return { tenant: existing, created: false };

  const derived = extractSlug(webId);
  const subdomain = firstFree(derived, (v) => !!db.getTenantBySubdomain(v));

  const wanted = normalizeSlug(preferredSlug);
  const bookingSlug = wanted && !db.getTenantBySlug(wanted)
    ? wanted
    : firstFree(derived, (v) => !!db.getTenantBySlug(v));

  let tenant;
  try {
    // The WebID doubles as the unique "email" key for Solid-only accounts.
    tenant = db.createTenant({ email: webId, webid: webId, solidPodUrl: podUrl, subdomain });
  } catch (err) {
    // A concurrent request may have created it first.
    const raced = db.getTenantByWebId(webId);
    if (raced) return { tenant: raced, created: false };
    throw err;
  }

  db.updateBookingSlug(tenant.id, bookingSlug);
  tenant = db.getTenantById(tenant.id);
  console.log(`[Tenants] Created tenant ${tenant.id} for ${webId} (slug: ${bookingSlug})`);
  return { tenant, created: true };
}
