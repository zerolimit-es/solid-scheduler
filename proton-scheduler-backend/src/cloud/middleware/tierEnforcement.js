import { checkLimit, TIERS } from '../config/tiers.js';
import * as db from '../models/database.js';
import { ensureTenant } from '../services/tenants.js';

export function requireFeature(featureKey) {
  return (req, res, next) => {
    const tenant = req.tenant;
    if (!tenant) return res.status(401).json({ error: 'Authentication required' });
    const result = checkLimit(tenant.tier, featureKey);
    if (!result.allowed) {
      return res.status(403).json({
        error: 'upgrade_required',
        message: `This feature requires a ${getMinimumTier(featureKey)} plan or higher.`,
        feature: featureKey,
        currentTier: tenant.tier,
      });
    }
    next();
  };
}

export function enforceLimit(limitKey, { metricName, autoIncrement = true } = {}) {
  const metric = metricName || limitKey;
  return async (req, res, next) => {
    const tenant = req.tenant;
    if (!tenant) return res.status(401).json({ error: 'Authentication required' });

    // Atomic check-and-increment to prevent race conditions where concurrent
    // requests could all pass the limit check before any increments occur.
    if (autoIncrement) {
      const result = db.atomicCheckAndIncrement(tenant.id, metric, tenant.tier, limitKey);
      if (!result.allowed) {
        return res.status(429).json({
          error: 'limit_reached',
          message: `You've reached your ${tenant.tier} plan limit for ${limitKey}.`,
          limit: result.limit, current: result.current, currentTier: tenant.tier,
        });
      }
      // Roll back the increment if the request ultimately fails
      const originalJson = res.json.bind(res);
      res.json = function (data) {
        if (res.statusCode >= 400) db.decrementUsage(tenant.id, metric);
        return originalJson(data);
      };
    } else {
      const currentUsage = db.getUsage(tenant.id, metric);
      const result = checkLimit(tenant.tier, limitKey, currentUsage);
      if (!result.allowed) {
        return res.status(429).json({
          error: 'limit_reached',
          message: `You've reached your ${tenant.tier} plan limit for ${limitKey}.`,
          limit: result.limit, current: result.current, currentTier: tenant.tier,
        });
      }
    }
    next();
  };
}

export function enforceResourceCount(limitKey, countFn) {
  return async (req, res, next) => {
    const tenant = req.tenant;
    if (!tenant) return res.status(401).json({ error: 'Authentication required' });
    try {
      const currentCount = await countFn(tenant);
      const result = checkLimit(tenant.tier, limitKey, currentCount);
      if (!result.allowed) {
        return res.status(403).json({
          error: 'limit_reached',
          message: `Your ${tenant.tier} plan allows up to ${result.limit} ${limitKey}.`,
          limit: result.limit, current: result.current, currentTier: tenant.tier,
        });
      }
      next();
    } catch (err) { console.error(`[TierEnforcement] Error:`, err); next(); }
  };
}

export function loadTenant() {
  return (req, res, next) => {
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

    // Check API key (Business tier API users)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ps_live_')) {
      const tenant = db.validateApiKey(authHeader.slice(7));
      if (tenant) { req.tenant = tenant; req.isApiAccess = true; return next(); }
      return res.status(401).json({ error: 'Invalid API key' });
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

export function brandingMiddleware() {
  return (req, res, next) => {
    if (!req.tenant) { res.locals.showBranding = true; return next(); }
    const result = checkLimit(req.tenant.tier, 'removeBranding');
    res.locals.showBranding = !result.allowed;
    next();
  };
}

function getMinimumTier(featureKey) {
  for (const [name, tier] of Object.entries(TIERS)) {
    if (tier.limits[featureKey] === true) return name;
  }
  return 'business';
}
