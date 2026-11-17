/**
 * Attach the signed-in user's account (tenant) to the request as req.tenant,
 * creating it on first sign-in. Routes key per-account state on it: booking
 * link, passkeys, calendar events, feed token.
 */

import * as db from '../models/database.js';
import { ensureTenant } from '../services/tenants.js';

export function loadTenant() {
  return (req, _res, next) => {
    // Check session tenantId first (fastest path), but verify it matches the current webId
    if (req.session?.tenantId) {
      const tenant = db.getTenantById(req.session.tenantId);
      if (tenant) {
        // If webId changed (user switched Pods), don't use the cached tenant
        if (!req.session.webId || tenant.webid === req.session.webId) {
          req.tenant = tenant;
          return next();
        }
        // webId mismatch — clear stale tenantId and fall through to webId lookup
        delete req.session.tenantId;
      }
    }

    // Bridge Solid auth → tenant: look up or create the tenant for this WebID
    if (req.session?.webId) {
      try {
        const { tenant } = ensureTenant(req.session.webId, { podUrl: req.session.podUrl || null });
        req.session.tenantId = tenant.id;
        req.tenant = tenant;
      } catch (err) {
        console.error('[Tenants] Could not load tenant:', err.message);
      }
    }

    next();
  };
}
