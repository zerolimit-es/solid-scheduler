/**
 * Auth Routes
 *
 * Uses @zerolimit/solid-auth's createAuthRouter with SolidScheduler-specific
 * lifecycle hooks for tenant management, post-login sync, and MFA.
 */

import { createAuthRouter } from '@zerolimit/packages/solid-auth/express';
import { verifyWebIdIssuer } from '@zerolimit/packages/solid-auth/core';
import { hostPolicy } from '../services/host-policy.js';
import { sessionManager, solidFetchMap } from '../middleware/auth.js';
import { syncBookingsToPod, syncCancellationsToPod, syncCalendarEventsToPod, importPodEventsToSQLite } from '../cloud/services/pod-sync.js';
import { getAvailability as getLocalAvailability, setAvailabilityPodPending } from '../cloud/models/bookings-db.js';
import { getTenantByWebId, getTenantBySlug, updateBookingSlug } from '../cloud/models/database.js';
import { extractSlug } from '../utils/webid.js';
import { ensureTenant } from '../cloud/services/tenants.js';
import * as solidService from '../services/solid.js';
import config from '../config/index.js';
import { startSession, revokeSession } from '../middleware/sessionLifetime.js';

// Re-export solidFetchMap so sync.js can still import it from here
export { solidFetchMap };

/**
 * Bring the Pod and the local database in step for one account: import
 * blocked time from the Pod, then push bookings, cancellations, blocked time
 * and availability to it. Runs in the background; never throws.
 *
 * Only call this for a session that is fully signed in. When the account has
 * passkeys that means after the passkey check, not before: otherwise a
 * stolen password alone would be enough to have bookings copied into the Pod.
 */
export function runPostLoginSync({ webId, podUrl, authenticatedFetch }) {
  return (async () => {
    try {
      if (!authenticatedFetch || !podUrl) return;
      const tenant = getTenantByWebId(webId);
      const timezone = tenant?.booking_slug
        ? (getLocalAvailability(tenant.booking_slug)?.timezone || 'Europe/Paris')
        : 'Europe/Paris';

      // Phase 1: Import Pod events into SQLite (catches events from other devices)
      try {
        if (tenant?.id) {
          const imported = await importPodEventsToSQLite(podUrl, authenticatedFetch, tenant.id, timezone);
          if (imported.calendarEvents > 0) {
            console.log(`[Auth] Imported ${imported.calendarEvents} calendar events from Pod`);
          }
        }
      } catch (importErr) {
        console.warn('[Auth] Pod import skipped:', importErr.message);
      }

      // Phase 2: Sync this account's unsynced bookings + calendar events to Pod
      const syncResult = await syncBookingsToPod(podUrl, authenticatedFetch, tenant?.booking_slug, timezone);
      console.log('[Auth] Post-login booking sync:', syncResult.synced, 'synced,', syncResult.failed, 'failed');

      // Bookings a visitor cancelled after they had reached the Pod
      const cancelResult = await syncCancellationsToPod(podUrl, authenticatedFetch, tenant?.booking_slug);
      if (cancelResult.total > 0) {
        console.log('[Auth] Post-login cancellation sync:', cancelResult.cancelled, 'cancelled,', cancelResult.failed, 'failed');
      }

      if (tenant?.id) {
        const calResult = await syncCalendarEventsToPod(podUrl, authenticatedFetch, timezone, tenant.id);
        if (calResult.synced > 0) {
          console.log('[Auth] Post-login calendar sync:', calResult.synced, 'synced');
        }
      }

      // Phase 3: Sync availability to Pod
      if (tenant?.booking_slug) {
        const localAvail = getLocalAvailability(tenant.booking_slug);
        if (localAvail) {
          if (localAvail.organizerName) localAvail.name = localAvail.organizerName;
          if (localAvail.organizerEmail) localAvail.email = localAvail.organizerEmail;
          if (!localAvail.days) {
            localAvail.days = {};
            for (const d of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) {
              if (localAvail[d]) localAvail.days[d] = localAvail[d];
            }
          }
          await solidService.saveAvailability(podUrl, localAvail, authenticatedFetch);
          setAvailabilityPodPending(tenant.booking_slug, false);
          console.log('[Auth] Post-login availability synced to Pod');
        }
      }
    } catch (syncErr) {
      console.error('[Auth] Post-login sync error:', syncErr.message);
    }
  })();
}

const router = createAuthRouter({
  sessionManager,
  baseUrl: config.baseUrl,
  frontendUrl: config.frontendUrl,
  clientName: 'SolidScheduler',
  defaultIdp: config.solid.defaultIdp,
  // The router's own requests to the identity provider (its sign-out address)
  fetch: hostPolicy.guardFetch(globalThis.fetch),

  // ── Sign-out: withdraw the session so copies of its cookie stop working ──
  onLogout: async (req) => {
    revokeSession(req);
  },

  // ── WebID check: read the profile only from a public address ────────────
  // The WebID comes from the identity provider's token, which the user may
  // control, so its host is checked before the server fetches the profile.
  verifyIssuer: async (webId, issuer) => {
    const check = await hostPolicy.check(webId);
    if (!check.ok) return { ok: false, reason: `WebID host refused: ${check.reason}` };
    return verifyWebIdIssuer(webId, issuer, { fetch: hostPolicy.guardFetch(globalThis.fetch) });
  },

  // ── Before login redirect: check and remember which IDP was chosen ──────
  // Any provider URL can be typed in, and the server contacts it, so it
  // must be on a public address (or be the operator's configured default).
  // Throwing here sends the user back with "provider could not be reached".
  onLogin: async (req, { oidcIssuer }) => {
    const check = await hostPolicy.check(oidcIssuer);
    if (!check.ok) {
      delete req.session.oidcIssuer;
      throw new Error(`Identity provider refused: ${check.reason}`);
    }
    req.session.oidcIssuer = oidcIssuer;
  },

  // ── After OIDC callback: tenant DB, post-login sync, MFA check ──────────
  onCallback: async (req, { webId, pods: listedPods, authenticatedFetch }) => {
    // Only Pods on addresses the server may contact are used
    const pods = await hostPolicy.filterAllowed(listedPods);
    if (pods.length < (listedPods?.length ?? 0)) {
      console.warn('[Auth] Ignored', listedPods.length - pods.length, 'Pod URL(s) on a non-public address');
    }
    req.session.podUrl = pods[0] || null;

    // The auth router has already checked that the WebID's profile names
    // this issuer as its solid:oidcIssuer (and rejected the login otherwise)
    // before calling this hook, so `webId` can be trusted here.

    // The sign-in stands: start its server-side lifetime (expiry, sign-out)
    startSession(req);

    // ── Make sure this WebID has a tenant (first sign-in creates it) ──
    // Everything below (slug, sync, MFA) is keyed on the tenant. On first
    // sign-in, claim the booking slug saved in the user's own Pod so an
    // existing install keeps its booking page, settings and bookings.
    try {
      if (!getTenantByWebId(webId)) {
        let preferredSlug = null;
        if (pods[0] && authenticatedFetch) {
          try {
            const podAvailability = await solidService.loadAvailability(pods[0], authenticatedFetch);
            preferredSlug = podAvailability?.bookingSlug || null;
          } catch (podErr) {
            console.warn('[Auth] Could not read Pod availability for slug:', podErr.message);
          }
        }
        ensureTenant(webId, { podUrl: pods[0] || null, preferredSlug });
      }
      req.session.tenantId = getTenantByWebId(webId)?.id;
    } catch (tenantErr) {
      console.warn('[Auth] Could not provision tenant:', tenantErr.message);
    }

    // Persist Pod URL and OIDC issuer to tenant DB record
    try {
      const tenant = getTenantByWebId(webId);
      if (tenant) {
        const { getDb } = await import('../cloud/models/database.js');
        const updates = [];
        const params = [];
        if (pods[0] && tenant.solid_pod_url !== pods[0]) {
          updates.push('solid_pod_url = ?');
          params.push(pods[0]);
        }
        if (req.session.oidcIssuer && tenant.oidc_issuer !== req.session.oidcIssuer) {
          updates.push('oidc_issuer = ?');
          params.push(req.session.oidcIssuer);
        }
        if (updates.length > 0) {
          updates.push('updated_at = CURRENT_TIMESTAMP');
          params.push(tenant.id);
          getDb()
            .prepare(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`)
            .run(...params);
          console.log('[Auth] Updated tenant record:', updates.join(', '));
        }
      }
    } catch (dbErr) {
      console.warn('[Auth] Could not update tenant record:', dbErr.message);
    }

    // ── Backfill booking slug for pre-existing tenants ──
    try {
      const tenant = getTenantByWebId(webId);
      if (tenant && (!tenant.booking_slug || tenant.booking_slug === 'my-booking')) {
        let slug = extractSlug(webId);
        if (getTenantBySlug(slug) && getTenantBySlug(slug).id !== tenant.id) {
          slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
        }
        updateBookingSlug(tenant.id, slug);
        console.log('[Auth] Backfilled booking slug:', slug);
      }
    } catch (slugErr) {
      console.warn('[Auth] Could not backfill booking slug:', slugErr.message);
    }

    // ── MFA check: if user has passkeys, flag MFA as pending ──
    // Skip MFA only if this session already passed the passkey check *for this
    // WebID* (e.g. a Pod reconnect). The cookie session outlives a switch to
    // another account, so an unbound flag let one account's passkey check
    // skip the next account's.
    delete req.session.mfaVerified; // legacy unbound flag
    let mfaPending = false;
    if (req.session?.mfaVerifiedWebId && req.session.mfaVerifiedWebId === webId) {
      console.log('[Auth] MFA already verified this session, skipping challenge');
    } else {
      try {
        const tenant = getTenantByWebId(webId);
        if (tenant) {
          const { getDb } = await import('../cloud/models/database.js');
          const pkCount = getDb()
            .prepare('SELECT COUNT(*) as count FROM passkeys WHERE tenant_id = ?')
            .get(tenant.id);
          mfaPending = !!(pkCount && pkCount.count > 0);
        }
      } catch (mfaErr) {
        // Cannot tell whether the account has passkeys: ask for one rather
        // than let the sign-in through without its second factor
        console.warn('[Auth] MFA check failed, requiring passkey:', mfaErr.message);
        mfaPending = true;
      }
    }

    // ── Sync with the Pod, once the sign-in is complete ──
    // With a passkey check pending, passkey.js runs it after the check passes.
    if (mfaPending) return { mfaPending: true };
    runPostLoginSync({ webId, podUrl: pods[0], authenticatedFetch });
    return null;
  },

  // ── Status endpoint extras: hasPasskeys field ──
  onStatus: async (req, _response) => {
    let hasPasskeys = false;
    try {
      const tenantId = req.tenant?.id || req.session?.tenantId;
      if (tenantId) {
        const { getDb } = await import('../cloud/models/database.js');
        const pkCount = getDb()
          .prepare('SELECT COUNT(*) as count FROM passkeys WHERE tenant_id = ?')
          .get(tenantId);
        hasPasskeys = pkCount && pkCount.count > 0;
      }
    } catch {}
    const oidcIssuer = req.session?.oidcIssuer || req.tenant?.oidc_issuer || null;
    return { hasPasskeys, oidcIssuer };
  },

  // ── Pod URL save: persist to tenant DB ──
  onPodUrlSave: async (req, { podUrl }) => {
    if (req.tenant) {
      try {
        const { getDb } = await import('../cloud/models/database.js');
        getDb()
          .prepare('UPDATE tenants SET solid_pod_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(podUrl, req.tenant.id);
      } catch (dbErr) {
        console.warn('[Auth] Could not update tenant Pod URL:', dbErr.message);
      }
    }
  },
});

export default router;
