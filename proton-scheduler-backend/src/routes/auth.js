/**
 * Auth Routes
 *
 * Uses @zerolimit/solid-auth's createAuthRouter with ProtonScheduler-specific
 * lifecycle hooks for tenant management, post-login sync, and MFA.
 */

import { createAuthRouter } from '@zerolimit/packages/solid-auth/express';
import { sessionManager, solidFetchMap } from '../middleware/auth.js';
import { getUserPods } from '../services/solid.js';
import { syncBookingsToPod, syncCalendarEventsToPod, importPodEventsToSQLite } from '../cloud/services/pod-sync.js';
import { getAvailability as getLocalAvailability } from '../cloud/models/bookings-db.js';
import { getTenantByWebId, getTenantBySlug, updateBookingSlug } from '../cloud/models/database.js';
import { extractSlug } from '../utils/webid.js';
import * as solidService from '../services/solid.js';
import config from '../config/index.js';

// Re-export solidFetchMap so sync.js can still import it from here
export { solidFetchMap };

const router = createAuthRouter({
  sessionManager,
  baseUrl: config.baseUrl,
  frontendUrl: config.frontendUrl,
  clientName: 'ProtonScheduler',
  defaultIdp: config.solid.defaultIdp,

  // ── Before login redirect: remember which IDP was chosen ────────────────
  onLogin: async (req, { oidcIssuer }) => {
    req.session.oidcIssuer = oidcIssuer;
  },

  // ── After OIDC callback: tenant DB, post-login sync, MFA check ──────────
  onCallback: async (req, { webId, pods, authenticatedFetch }) => {
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

        // Phase 2: Sync unsynced bookings + calendar events to Pod
        const syncResult = await syncBookingsToPod(pods[0], authenticatedFetch, timezone);
        console.log('[Auth] Post-login booking sync:', syncResult.synced, 'synced,', syncResult.failed, 'failed');

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
    // Skip MFA if the session already passed verification (e.g. Pod reconnect
    // after an earlier successful passkey check in the same session).
    if (req.session?.mfaVerified) {
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
