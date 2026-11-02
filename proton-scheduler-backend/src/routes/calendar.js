/**
 * Calendar feed token routes (signed-in user)
 *
 * GET  /api/calendar/feed-token             The account's feed URL (created on first request)
 * POST /api/calendar/feed-token/regenerate  Replace the token; the old URL stops working
 *
 * The feed itself is public and token-authenticated (the URL is the secret),
 * served by calendar-feed.js at /api/calendar/feed/<token>.ics, which is
 * under /api so the bundled reverse proxies route it to the backend, and at
 * /cal/<token>.ics for setups that reach the backend directly.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { adminLimiter, publicReadLimiter } from '../middleware/rateLimit.js';
import { getFeedToken, createFeedToken } from '../cloud/models/calendar-events-db.js';

const router = Router();

export const FEED_PATH_PREFIX = '/api/calendar/feed/';

function feedInfo(token) {
  return { token, feedPath: `${FEED_PATH_PREFIX}${token}.ics` };
}

/** Feed tokens belong to a tenant; a session without one has nothing to scope them to. */
function requireTenant(req, res, next) {
  if (!req.tenant?.id) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Please log in to access this resource' });
  }
  next();
}

router.get('/feed-token', publicReadLimiter, requireAuth(), requireTenant, (req, res) => {
  try {
    const token = getFeedToken(req.tenant.id) || createFeedToken(req.tenant.id);
    res.json(feedInfo(token));
  } catch (err) {
    console.error('[Calendar] Feed token error:', err.message);
    res.status(500).json({ error: 'Failed to get calendar feed' });
  }
});

router.post('/feed-token/regenerate', adminLimiter, requireAuth(), requireTenant, (req, res) => {
  try {
    // One token per tenant (unique index): this replaces the old row.
    const token = createFeedToken(req.tenant.id);
    console.log('[Calendar] Feed token regenerated for tenant', req.tenant.id);
    res.json(feedInfo(token));
  } catch (err) {
    console.error('[Calendar] Feed token regenerate error:', err.message);
    res.status(500).json({ error: 'Failed to regenerate calendar feed' });
  }
});

export default router;
