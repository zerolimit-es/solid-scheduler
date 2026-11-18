/**
 * Availability Routes
 * 
 * Manage user availability settings stored in their Solid Pod:
 * - GET /api/availability - Get availability settings
 * - PUT /api/availability - Update availability settings
 * - GET /api/availability/slots - The organizer's own booking slots for a date
 */

import { Router } from 'express';
import { requireAuth, getAuthenticatedFetch } from '../middleware/auth.js';
import { getAvailability as getLocalAvailability, saveAvailability as saveLocalAvailability } from '../cloud/models/bookings-db.js';
import { isRealDate, slotsFor } from '../services/slots.js';
import solidService from '../services/solid.js';
import config from '../config/index.js';
import { changeBookingSlug, SlugTakenError, getTenantBySlug } from '../cloud/models/database.js';
import { normalizeSlug } from '../cloud/services/tenants.js';
import { safeMessage } from '../utils/errorResponse.js';
import { validate, updateAvailabilitySchema } from '../middleware/validate.js';
import { selectPod, PodNotAllowedError } from '../utils/pod.js';

const router = Router();

/**
 * GET /api/availability
 * Get the authenticated user's availability settings
 */
router.get('/', requireAuth(), async (req, res) => {
  // Try Pod first, fall back to SQLite
  try {
    const fetch = await getAuthenticatedFetch(req.solidSession, req.user?.webId || req.session?.webId);
    const pods = req.user?.pods?.length ? req.user.pods : await solidService.getUserPods(req.user.webId, fetch).catch(() => [req.session?.podUrl].filter(Boolean));
    if (pods.length > 0) {
      const podUrl = selectPod(req.query.pod, pods);
      const availability = await solidService.loadAvailability(podUrl, fetch);
      if (availability) {
        // Guard against cross-tenant contamination: verify Pod data belongs to this tenant
        const podSlug = availability.bookingSlug;
        if (podSlug && req.tenant) {
          const tenantSlug = req.tenant.booking_slug;
          const isContaminated = tenantSlug
            ? podSlug !== tenantSlug
            : (() => { const owner = getTenantBySlug(podSlug); return owner && owner.id !== req.tenant.id; })();
          if (isContaminated) {
            console.log(`[Availability] Pod data slug "${podSlug}" belongs to another tenant — ignoring`);
            throw new Error('Contaminated Pod data');
          }
        }
        // Map Pod field names back to frontend names
        availability.organizerName = availability.name || '';
        availability.organizerEmail = availability.email || '';
        // Map Pod field names back to frontend names
        // Denormalize: Pod returns nested days, frontend expects flat
        if (availability.days) {
          for (const [day, settings] of Object.entries(availability.days)) {
            availability[day] = {
              enabled: settings.enabled || false,
              start: settings.start || '09:00',
              end: settings.end || '17:00',
            };
          }
        }
        // Ensure all 7 days exist
        for (const d of ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']) {
          if (!availability[d]) availability[d] = { enabled: false, start: '09:00', end: '17:00' };
        }
        // Also update SQLite with Pod data (Pod is source of truth)
        const slug = availability.bookingSlug || req.tenant?.booking_slug || null;
        try { saveLocalAvailability(availability, slug); } catch {}
        // The account's booking link is the one in the database
        if (req.tenant?.booking_slug) availability.bookingSlug = req.tenant.booking_slug;
        return res.json({ configured: true, podUrl, availability, source: 'pod' });
      }
    }
  } catch (podErr) {
    console.log('[Availability] Pod read failed, trying SQLite:', podErr.message);
  }

  // Fall back to SQLite (scoped by tenant's booking slug)
  try {
    const local = getLocalAvailability(req.tenant?.booking_slug);
    if (local) {
      // Map field names
      local.organizerName = local.organizerName || local.name || '';
      local.organizerEmail = local.organizerEmail || local.email || '';
      // Map field names
      // Denormalize if needed
      if (local.days) {
        for (const [day, settings] of Object.entries(local.days)) {
          local[day] = {
            enabled: settings.enabled || false,
            start: settings.start || '09:00',
            end: settings.end || '17:00',
          };
        }
      }
      // Ensure all 7 days exist
      for (const d of ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']) {
        if (!local[d]) local[d] = { enabled: false, start: '09:00', end: '17:00' };
      }
      if (req.tenant?.booking_slug) local.bookingSlug = req.tenant.booking_slug;
      return res.json({ configured: true, podUrl: 'local', availability: local, source: 'sqlite' });
    }
    return res.json({
      configured: false,
      message: 'Availability not configured yet',
      bookingSlug: req.tenant?.booking_slug || null,
    });
  } catch (dbErr) {
    return res.status(500).json({ error: 'Failed to load availability', message: dbErr.message });
  }
});

/**
 * PUT /api/availability
 * Update the authenticated user's availability settings
 */
router.put('/', requireAuth(), validate(updateAvailabilitySchema), async (req, res) => {
  const availability = req.body;

  // Validate
  if (!availability.eventDuration) {
    return res.status(400).json({ error: 'Invalid availability data', message: 'eventDuration is required' });
  }

  // Normalize: frontend sends flat (availability.monday), Pod expects nested (availability.days.monday)
  const dayNames = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  if (!availability.days || Object.keys(availability.days).length === 0) {
    availability.days = {};
  }
  for (const day of dayNames) {
    if (availability[day]) {
      availability.days[day] = {
        enabled: availability[day].enabled || false,
        start: availability[day].start || '09:00',
        end: availability[day].end || '17:00',
      };
    }
  }

  // Map frontend field names to Pod field names
  if (availability.organizerName !== undefined) availability.name = availability.organizerName;
  if (availability.organizerEmail !== undefined) availability.email = availability.organizerEmail;

  // 1. Always save to SQLite first. The booking link is normalised to
  // lowercase letters, digits and dashes; one with none of those is refused.
  let slug = req.tenant?.booking_slug || null;
  if (availability.bookingSlug) {
    slug = normalizeSlug(availability.bookingSlug);
    if (!slug) {
      return res.status(400).json({
        error: 'Invalid booking link',
        message: 'A booking link needs at least one letter or digit.',
      });
    }
  }
  if (slug) availability.bookingSlug = slug;

  // Move the account to the new slug first, taking its bookings and saved
  // availability along (they are keyed by slug). Refused when the slug is
  // held by another account or still has someone else's data under it.
  if (slug && req.tenant && req.tenant.booking_slug !== slug) {
    try {
      changeBookingSlug(req.tenant.id, slug);
      req.tenant.booking_slug = slug;
      console.log(`[Availability] Updated tenant booking_slug to "${slug}"`);
    } catch (err) {
      if (err instanceof SlugTakenError) {
        return res.status(409).json({ error: 'This booking URL is already taken. Please choose a different one.' });
      }
      console.error('[Availability] Could not change booking slug:', err.message);
      return res.status(500).json({ error: 'Failed to save locally', message: safeMessage(err) });
    }
  }

  try {
    saveLocalAvailability(availability, slug);
    console.log('[Availability] ✓ Saved to SQLite' + (slug ? ' (slug: ' + slug + ')' : ''));
  } catch (dbErr) {
    console.error('[Availability] SQLite save failed:', dbErr.message);
    return res.status(500).json({ error: 'Failed to save locally', message: dbErr.message });
  }

  // 2. Try to also save to Pod
  let podSaved = false;
  try {
    const fetch = await getAuthenticatedFetch(req.solidSession, req.user?.webId || req.session?.webId);
    const pods = req.user?.pods?.length ? req.user.pods : await solidService.getUserPods(req.user.webId, fetch).catch(() => [req.session?.podUrl].filter(Boolean));
    if (pods.length > 0) {
      const podUrl = selectPod(req.query.pod, pods);
      await solidService.saveAvailability(podUrl, availability, fetch);
      podSaved = true;
      console.log('[Availability] ✓ Saved to Pod');
    }
  } catch (podErr) {
    console.log('[Availability] Pod save failed (will sync on next login):', podErr.message);
  }

  res.json({
    success: true,
    message: podSaved ? 'Saved to Pod and local DB' : 'Saved locally (will sync to Pod on next login)',
    source: podSaved ? 'pod+sqlite' : 'sqlite',
    bookingSlug: slug,
  });
});

/**
 * GET /api/availability/slots?date=YYYY-MM-DD
 * The signed-in organizer's own booking slots for a date: the same list
 * their public booking page offers (see services/slots.js), so a slot shown
 * free here is one that can be booked. The saved hours are the ones in the
 * database, which the dashboard brings in step with the Pod when it loads.
 */
router.get('/slots', requireAuth(), (req, res) => {
  try {
    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'Missing date', message: 'Date parameter is required (YYYY-MM-DD format)' });
    }
    if (!isRealDate(date)) {
      return res.status(400).json({ error: 'Invalid date', message: 'date must be YYYY-MM-DD' });
    }
    const slug = req.tenant?.booking_slug;
    if (!slug) return res.json({ date, slots: [], count: 0 });
    res.json(slotsFor(slug, date, req.tenant.id));
  } catch (error) {
    console.error('Get slots error:', error);
    res.status(500).json({ error: 'Failed to get available slots', message: safeMessage(error) });
  }
});

/**
 * POST /api/availability/public
 * Make availability publicly accessible (create public booking page)

 */
router.post('/public', requireAuth(), async (req, res) => {
  try {
    const fetch = await getAuthenticatedFetch(req.solidSession, req.user?.webId || req.session?.webId);
    const pods = req.user?.pods?.length ? req.user.pods : await solidService.getUserPods(req.user.webId, fetch).catch(() => [req.session?.podUrl].filter(Boolean));
    const podUrl = selectPod(req.query.pod, pods);

    const publicInfo = req.body;
    
    if (!publicInfo.name || !publicInfo.bookingSlug) {
      return res.status(400).json({
        error: 'Invalid data',
        message: 'name and bookingSlug are required',
      });
    }

    // Normalize the slug, then move the account (and its bookings) to it
    // before anything is written to the Pod.
    publicInfo.bookingSlug = normalizeSlug(publicInfo.bookingSlug);
    if (!publicInfo.bookingSlug) {
      return res.status(400).json({ error: 'Invalid data', message: 'bookingSlug is not a valid booking URL' });
    }
    if (req.tenant) {
      try {
        changeBookingSlug(req.tenant.id, publicInfo.bookingSlug);
        req.tenant.booking_slug = publicInfo.bookingSlug;
      } catch (err) {
        if (err instanceof SlugTakenError) {
          return res.status(409).json({ error: 'This booking URL is already taken. Please choose a different one.' });
        }
        throw err;
      }
    }

    const profileUrl = await solidService.setupPublicBookingPage(podUrl, publicInfo, fetch);
    
    // Generate the public booking URL
    const bookingUrl = `${config.frontendUrl}/book/${publicInfo.bookingSlug}`;

    res.json({
      success: true,
      message: 'Public booking page created',
      profileUrl,
      bookingUrl,
    });
  } catch (error) {
    console.error('Create public page error:', error);
    res.status(error instanceof PodNotAllowedError ? 400 : 500).json({
      error: 'Failed to create public booking page',
      message: safeMessage(error),
    });
  }
});

export default router;
