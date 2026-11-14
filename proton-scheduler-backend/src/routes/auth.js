/**
 * Auth Routes
 *
 * Uses @zerolimit/solid-auth's createAuthRouter with SolidScheduler-specific
 * lifecycle hooks for tenant management, post-login sync, and MFA.
 */

import { createAuthRouter } from '@zerolimit/packages/solid-auth/express';
import { sessionManager, solidFetchMap } from '../middleware/auth.js';
import { getUserPods } from '../services/solid.js';
import { syncBookingsToPod, syncCancellationsToPod, syncCalendarEventsToPod, importPodEventsToSQLite } from '../cloud/services/pod-sync.js';
import { getAvailability as getLocalAvailability } from '../cloud/models/bookings-db.js';
import { getTenantByWebId, getTenantBySlug, updateBookingSlug } from '../cloud/models/database.js';
import { extractSlug } from '../utils/webid.js';
import { ensureTenant } from '../cloud/services/tenants.js';
import { verifyWebIdIssuer } from '../utils/webid-issuer.js';
import * as solidService from '../services/solid.js';
import config from '../config/index.js';

// Re-export solidFetchMap so sync.js can still import it from here
export { solidFetchMap };

/**
 * Undo a login the auth router has already completed: end the Solid session,
 * drop its authenticated fetch, and clear every identity field from the
 * cookie session. Flags the request so the callback redirect reports failure
 * (see rejectedLoginRedirect).
 */
async function rejectLogin(req) {
  try {
    if (req.solidSession) await sessionManager.logout(req.solidSession);
  } catch (err) {
    console.warn('[Auth] Could not end rejected Solid session:', err.message);
  }
  if (req.session) {
    for (const key of ['webId', 'solidSessionId', 'podUrl', 'tenantId', 'oidcIssuer',
      'mfaPending', 'mfaVerified', 'mfaVerifiedWebId', 'passkeyVerifiedAt', 'passkeyVerifiedFor',
      'returnTo']) {
      delete req.session[key];
    }
  }
  delete req.user;
  delete req.tenant;
  req.loginRejected = true;
}

/**
 * Mount before the auth router on /api/auth/callback. When onCallback has
 * rejected a login, replace the router's "login=success" redirect with a
 * failure redirect to the frontend.
 */
export function rejectedLoginRedirect(req, res, next) {
  const originalRedirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    if (req.loginRejected) {
      const query = new URLSearchParams({
        login: 'failed',
        message: 'This identity provider is not authorised for that WebID.',
      }).toString();
      const base = config.frontendUrl || '/';
      return originalRedirect(`${base}${base.includes('?') ? '&' : '?'}${query}`);
    }
    return originalRedirect(...args);
  };
  next();
}

const router = createAuthRouter({
  sessionManager,
  baseUrl: config.baseUrl,
  frontendUrl: config.frontendUrl,
  clientName: 'SolidScheduler',
  defaultIdp: config.solid.defaultIdp,

  // ── Before login redirect: remember which IDP was chosen ────────────────
  onLogin: async (req, { oidcIssuer }) => {
    req.session.oidcIssuer = oidcIssuer;
  },

  // ── After OIDC callback: tenant DB, post-login sync, MFA check ──────────
  onCallback: async (req, { webId, pods, authenticatedFetch }) => {
    // ── Solid-OIDC: the WebID must name this issuer as its solid:oidcIssuer ──
    // Must run first, before anything trusts `webId`. The auth router logs
    // the user in *before* calling this hook and ignores errors it throws, so
    // on failure we tear the session down ourselves (fail closed).
    let issuerCheck;
    try {
      issuerCheck = await verifyWebIdIssuer(webId, req.session?.oidcIssuer);
    } catch (err) {
      issuerCheck = { ok: false, reason: err.message };
    }
    if (!issuerCheck.ok) {
      console.warn('[Auth] Rejected login: WebID/issuer mismatch —', issuerCheck.reason);
      await rejectLogin(req);
      return null;
    }

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

    // ── Post-login: Import from Pod → then Sync to Pod (fire-and-forget) ──
    (async () => {
      try {
        if (!authenticatedFetch || !pods[0]) return;
        const tenant = getTenantByWebId(webId);
        const timezone = tenant?.booking_slug
          ? (getLocalAvailability(tenant.booking_slug)?.timezone || 'Europe/Paris')
          : 'Europe/Paris';

        // Phase 1: Import Pod events into SQLite (catches events from other devices)
        try {
          if (tenant?.id) {
            const imported = await importPodEventsToSQLite(pods[0], authenticatedFetch, tenant.id, timezone);
            if (imported.calendarEvents > 0) {
              console.log(`[Auth] Imported ${imported.calendarEvents} calendar events from Pod`);
            }
          }
        } catch (importErr) {
          console.warn('[Auth] Pod import skipped:', importErr.message);
        }

        // Phase 2: Sync this account's unsynced bookings + calendar events to Pod
        const syncResult = await syncBookingsToPod(pods[0], authenticatedFetch, tenant?.booking_slug, timezone);
        console.log('[Auth] Post-login booking sync:', syncResult.synced, 'synced,', syncResult.failed, 'failed');

        // Bookings a visitor cancelled after they had reached the Pod
        const cancelResult = await syncCancellationsToPod(pods[0], authenticatedFetch, tenant?.booking_slug);
        if (cancelResult.total > 0) {
          console.log('[Auth] Post-login cancellation sync:', cancelResult.cancelled, 'cancelled,', cancelResult.failed, 'failed');
        }

        if (tenant?.id) {
          const calResult = await syncCalendarEventsToPod(pods[0], authenticatedFetch, timezone, tenant.id);
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
            await solidService.saveAvailability(pods[0], localAvail, authenticatedFetch);
            console.log('[Auth] Post-login availability synced to Pod');
          }
        }
      } catch (syncErr) {
        console.error('[Auth] Post-login sync error:', syncErr.message);
      }
    })();

    // ── MFA check: if user has passkeys, flag MFA as pending ──
    // Skip MFA only if this session already passed the passkey check *for this
    // WebID* (e.g. a Pod reconnect). The cookie session outlives a switch to
    // another account, so an unbound flag let one account's passkey check
    // skip the next account's.
    delete req.session.mfaVerified; // legacy unbound flag
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
          if (pkCount && pkCount.count > 0) {
            return { mfaPending: true };
          }
        }
      } catch (mfaErr) {
        console.warn('[Auth] MFA check failed, proceeding without:', mfaErr.message);
      }
    }

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
  onPodUrlSave: async (req, { webId, podUrl }) => {
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
