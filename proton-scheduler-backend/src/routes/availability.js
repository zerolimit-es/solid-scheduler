/**
 * Availability Routes
 * 
 * Manage user availability settings stored in their Solid Pod:
 * - GET /api/availability - Get availability settings
 * - PUT /api/availability - Update availability settings
 * - GET /api/availability/slots - Get available time slots
 * - GET /api/availability/dates - Get available dates in a month
 */

import { Router } from 'express';
import { requireAuth, getAuthenticatedFetch } from '../middleware/auth.js';
import { getAvailability as getLocalAvailability, saveAvailability as saveLocalAvailability, getBookedSlots } from '../cloud/models/bookings-db.js';
import { getBlockedSlots as getCalendarBlockedSlots } from '../cloud/models/calendar-events-db.js';
import solidService from '../services/solid.js';
import calendarService from '../services/calendar.js';
import config from '../config/index.js';
import { checkLimit } from '../cloud/config/tiers.js';
import { getUsage, updateBookingSlug, getTenantBySlug } from '../cloud/models/database.js';
import { safeMessage } from '../utils/errorResponse.js';

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
      const podUrl = req.query.pod || pods[0];
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
      return res.json({ configured: true, podUrl: 'local', availability: local, source: 'sqlite' });
    }
    return res.json({ configured: false, message: 'Availability not configured yet' });
  } catch (dbErr) {
    return res.status(500).json({ error: 'Failed to load availability', message: dbErr.message });
  }
});

/**
 * PUT /api/availability
 * Update the authenticated user's availability settings
 */
router.put('/', requireAuth(), async (req, res) => {
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

  // Map frontend field names to Pod field names

  // 1. Always save to SQLite first (normalize slug to lowercase)
  const rawSlug = availability.bookingSlug || req.tenant?.booking_slug || null;
  const slug = rawSlug ? rawSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') : null;
  if (availability.bookingSlug) availability.bookingSlug = slug;

  // Check slug uniqueness before saving
  if (slug && req.tenant && req.tenant.booking_slug !== slug) {
    try {
      const existing = getTenantBySlug(slug);
      if (existing && existing.id !== req.tenant.id) {
        return res.status(409).json({ error: 'This booking URL is already taken. Please choose a different one.' });
      }
    } catch (err) {
      console.warn('[Availability] Slug uniqueness check failed:', err.message);
    }
  }

  try {
    saveLocalAvailability(availability, slug);
    console.log('[Availability] ✓ Saved to SQLite' + (slug ? ' (slug: ' + slug + ')' : ''));
  } catch (dbErr) {
    console.error('[Availability] SQLite save failed:', dbErr.message);
    return res.status(500).json({ error: 'Failed to save locally', message: dbErr.message });
  }

  // Keep tenant's booking_slug in sync so future lookups work
  if (slug && req.tenant && req.tenant.booking_slug !== slug) {
    try {
      updateBookingSlug(req.tenant.id, slug);
      req.tenant.booking_slug = slug;
      console.log(`[Availability] Updated tenant booking_slug to "${slug}"`);
    } catch (err) {
      console.warn('[Availability] Failed to update tenant slug:', err.message);
    }
  }

  // 2. Try to also save to Pod
  let podSaved = false;
  try {
    const fetch = await getAuthenticatedFetch(req.solidSession, req.user?.webId || req.session?.webId);
    const pods = req.user?.pods?.length ? req.user.pods : await solidService.getUserPods(req.user.webId, fetch).catch(() => [req.session?.podUrl].filter(Boolean));
    if (pods.length > 0) {
      const podUrl = req.query.pod || pods[0];
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
  });
});

/**
 * GET /api/availability/slots
 * Get available time slots for a specific date
 * Query params:
 *   - date: Date in YYYY-MM-DD format (required)
 *   - pod: Pod URL (optional, uses first pod)
 */
router.get('/slots', requireAuth(), async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        error: 'Missing date',
        message: 'Date parameter is required (YYYY-MM-DD format)',
      });
    }

    // Resolve availability — try Pod (source of truth), fall back to SQLite
    const slug = req.tenant?.booking_slug;
    let avail = null;

    try {
      const fetch = await getAuthenticatedFetch(req.solidSession, req.user?.webId || req.session?.webId);
      const pods = req.user?.pods?.length
        ? req.user.pods
        : await solidService.getUserPods(req.user.webId, fetch).catch(() => [req.session?.podUrl].filter(Boolean));
      const podUrl = req.query.pod || pods[0];
      if (podUrl) {
        const podAvail = await solidService.loadAvailability(podUrl, fetch);
        if (podAvail) avail = podAvail;
      }
    } catch {
      // Pod unavailable — fall back to SQLite below
    }

    if (!avail) {
      avail = getLocalAvailability(slug);
    }

    if (!avail) {
      return res.json({ date, slots: [], count: 0 });
    }

    // Determine which day of the week this date falls on
    const [year, month, day] = date.split('-').map(Number);
    const dateObj = new Date(year, month - 1, day);
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayName = dayNames[dateObj.getDay()];

    // Get day settings from nested (Pod) or flat (SQLite) structure
    let daySettings = null;
    if (avail.days && avail.days[dayName]) daySettings = avail.days[dayName];
    else if (avail[dayName]) daySettings = avail[dayName];

    if (!daySettings || !daySettings.enabled) {
      return res.json({ date, slots: [], count: 0 });
    }

    // Generate slots using minute-based arithmetic (timezone-safe)
    const startTime = daySettings.start || '09:00';
    const endTime = daySettings.end || '17:00';
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    const slotStart = startH * 60 + startM;
    const slotEnd = endH * 60 + endM;

    // Filter past slots if today (in user's timezone)
    const tz = avail.timezone || 'Europe/Paris';
    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const todayStr = nowInTz.getFullYear() + '-' +
      String(nowInTz.getMonth() + 1).padStart(2, '0') + '-' +
      String(nowInTz.getDate()).padStart(2, '0');
    const isToday = date === todayStr;
    const nowMin = isToday ? nowInTz.getHours() * 60 + nowInTz.getMinutes() : 0;

    // Check already-booked slots from SQLite + calendar event blocks
    const booked = slug ? getBookedSlots(slug, date) : [];
    const calBlocked = req.tenant?.id ? getCalendarBlockedSlots(req.tenant.id, date) : [];
    const bookedTimes = new Set([
      ...booked.map(b => b.start_time),
      ...calBlocked.map(b => b.start_time),
    ]);

    const duration = avail.eventDuration || 30;
    const slots = [];
    for (let m = slotStart; m + duration <= slotEnd; m += duration) {
      if (isToday && m <= nowMin + 15) continue;
      const hour = Math.floor(m / 60);
      const min = m % 60;
      const time = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
      const key = `${date} ${time}`;
      const isBooked = bookedTimes.has(key);
      const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const displayTime = `${h12}:${min.toString().padStart(2, '0')} ${ampm}`;
      slots.push({ time, displayTime, isBooked });
    }

    res.json({ date, slots, count: slots.filter(s => !s.isBooked).length });
  } catch (error) {
    console.error('Get slots error:', error);
    res.status(500).json({
      error: 'Failed to get available slots',
      message: safeMessage(error),
    });
  }
});

/**
 * GET /api/availability/dates
 * Get dates with available slots in a given month
 * Query params:
 *   - year: Year (required)
 *   - month: Month 1-12 (required)
 *   - pod: Pod URL (optional)
 */
router.get('/dates', requireAuth(), async (req, res) => {
  try {
    const { year, month, pod } = req.query;
    
    if (!year || !month) {
      return res.status(400).json({
        error: 'Missing parameters',
        message: 'Year and month are required',
      });
    }
    
    let fetch;
    try {
      fetch = await getAuthenticatedFetch(req.solidSession, req.user?.webId || req.session?.webId);
    } catch {
      return res.json({ year: parseInt(year), month: parseInt(month), availableDates: [], count: 0, source: 'no-auth' });
    }
    const pods = req.user?.pods?.length ? req.user.pods : await solidService.getUserPods(req.user.webId, fetch).catch(() => [req.session?.podUrl].filter(Boolean));
    const podUrl = pod || pods[0];

    if (!podUrl) {
      return res.json({ year: parseInt(year), month: parseInt(month), availableDates: [], count: 0, source: 'no-pod' });
    }

    const dates = await calendarService.getAvailableDatesInMonth(
      podUrl,
      parseInt(year),
      parseInt(month),
      fetch
    );
    
    res.json({
      year: parseInt(year),
      month: parseInt(month),
      availableDates: dates,
      count: dates.length,
    });
  } catch (error) {
    console.error('Get dates error:', error);
    res.status(500).json({
      error: 'Failed to get available dates',
      message: safeMessage(error),
    });
  }
});

/**
 * POST /api/availability/public
 * Make availability publicly accessible (create public booking page)
 *
 * PHASE 1 FIX: Enforces bookingPages tier limit before allowing creation.
 */
router.post('/public', requireAuth(), async (req, res) => {
  try {
    // -----------------------------------------------------------------------
    // Tier enforcement: bookingPages limit
    // Prevents free-tier users from creating more booking pages than allowed.
    // req.tenant is populated by loadTenant() in the cloud layer (integrate.js)
    // -----------------------------------------------------------------------
    if (req.tenant) {
      const currentUsage = getUsage(req.tenant.id, 'bookingPages');
      const check = checkLimit(req.tenant.tier, 'bookingPages', currentUsage);
      if (!check.allowed) {
        return res.status(429).json({
          error: 'limit_reached',
          message: `Your ${req.tenant.tier} plan allows ${check.limit} booking page${check.limit === 1 ? '' : 's'}. Upgrade to Pro for unlimited.`,
          limit: check.limit,
          current: check.current,
          currentTier: req.tenant.tier,
        });
      }
    }

    const fetch = await getAuthenticatedFetch(req.solidSession, req.user?.webId || req.session?.webId);
    const pods = req.user?.pods?.length ? req.user.pods : await solidService.getUserPods(req.user.webId, fetch).catch(() => [req.session?.podUrl].filter(Boolean));
    const podUrl = req.query.pod || pods[0];

    const publicInfo = req.body;
    
    if (!publicInfo.name || !publicInfo.bookingSlug) {
      return res.status(400).json({
        error: 'Invalid data',
        message: 'name and bookingSlug are required',
      });
    }

    // Normalize slug to lowercase
    publicInfo.bookingSlug = publicInfo.bookingSlug.toLowerCase();

    const profileUrl = await solidService.setupPublicBookingPage(podUrl, publicInfo, fetch);
    
    // Generate the public booking URL
    const bookingUrl = `${config.frontendUrl}/book/${publicInfo.bookingSlug}`;

    // Phase 2 (Task 12): Link booking slug to tenant record for direct lookup
    if (req.tenant) {
      updateBookingSlug(req.tenant.id, publicInfo.bookingSlug);
    }

    // Track usage: increment bookingPages counter for this tenant
    if (req.tenant) {
      const { incrementUsage } = await import('../cloud/models/database.js');
      incrementUsage(req.tenant.id, 'bookingPages');
    }

    res.json({
      success: true,
      message: 'Public booking page created',
      profileUrl,
      bookingUrl,
    });
  } catch (error) {
    console.error('Create public page error:', error);
    res.status(500).json({
      error: 'Failed to create public booking page',
      message: safeMessage(error),
    });
  }
});

export default router;
