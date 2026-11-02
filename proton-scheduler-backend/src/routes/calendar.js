/**
 * Calendar routes (signed-in user)
 *
 * GET  /api/calendar/feed-token             The account's feed URL (created on first request)
 * POST /api/calendar/feed-token/regenerate  Replace the token; the old URL stops working
 *
 * Calendar events ("blocked time"): time the organizer is busy. Events block
 * the booking slots they overlap and appear in the calendar feed.
 * GET    /api/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
 * POST   /api/calendar/events
 * PUT    /api/calendar/events/:id
 * DELETE /api/calendar/events/:id
 * POST   /api/calendar/import                Import a .ics file (text/calendar body,
 *                                            or JSON { icsContent } for small files)
 *
 * Event times are naive local times ("YYYY-MM-DD HH:MM") in the organizer's
 * availability timezone, the same form they are stored in. For all-day events
 * `start`/`end` may be dates ("YYYY-MM-DD"); `end` is the last day, inclusive.
 * Responses give all-day `end` as the exclusive next midnight.
 *
 * The feed itself is public and token-authenticated (the URL is the secret),
 * served by calendar-feed.js at /api/calendar/feed/<token>.ics, which is
 * under /api so the bundled reverse proxies route it to the backend, and at
 * /cal/<token>.ics for setups that reach the backend directly.
 */

import express, { Router } from 'express';
import { requireAuth, getAuthenticatedFetch } from '../middleware/auth.js';
import { adminLimiter, publicReadLimiter, calendarWriteLimiter } from '../middleware/rateLimit.js';
import {
  getFeedToken,
  createFeedToken,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  getCalendarEventsInRange,
  getCalendarEventByIcsUid,
} from '../cloud/models/calendar-events-db.js';
import { getAvailability } from '../cloud/models/bookings-db.js';
import { getDb } from '../cloud/models/database.js';
import { syncCalendarEventsToPod } from '../cloud/services/pod-sync.js';
import solidService from '../services/solid.js';
import { parseICSCalendar } from '../utils/ics.js';
import { parseRRule } from '../utils/rrule.js';
import { parseNaive, addDays, naiveDiffMinutes, instantToNaive } from '../utils/tz.js';

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

// ── Calendar events (blocked time) ─────────────────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EVENT_MINUTES = 31 * 24 * 60;
const MAX_RANGE_DAYS = 400;
const MAX_IMPORT_EVENTS = 2000;

/** The organizer's availability timezone (same default as the rest of the app). */
function organizerTimezone(tenant) {
  return (tenant?.booking_slug && getAvailability(tenant.booking_slug)?.timezone) || 'Europe/Paris';
}

function toApi(row) {
  return {
    id: row.id,
    title: row.title,
    start: row.start_time,
    end: row.end_time,
    allDay: !!row.all_day,
    recurrence: row.recurrence || null,
    notes: row.notes || '',
    location: row.location || '',
    color: row.color || '#6366F1',
    imported: !!row.ics_uid,
    syncedToPod: !!row.synced_to_pod,
  };
}

function validRRule(value) {
  if (typeof value !== 'string' || value.length > 300 || !/^[A-Z0-9=;,:+-]+$/i.test(value)) return false;
  return /(^|;)FREQ=/i.test(value) && !!parseRRule(value);
}

/**
 * Validate an event, given as the full desired state.
 * @returns {{ ok: true, fields: object } | { ok: false, error: string }}
 */
function validateEvent(input) {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 200) return { ok: false, error: 'title is required (max 200 characters)' };

  const allDay = !!input.allDay;
  let startTime;
  let endTime;
  if (allDay) {
    const startDate = String(input.start ?? '').slice(0, 10);
    const lastDate = String(input.end ?? input.start ?? '').slice(0, 10);
    if (!DATE.test(startDate) || !parseNaive(`${startDate} 00:00`)) return { ok: false, error: 'start must be a date (YYYY-MM-DD)' };
    if (!DATE.test(lastDate) || !parseNaive(`${lastDate} 00:00`)) return { ok: false, error: 'end must be a date (YYYY-MM-DD)' };
    startTime = `${startDate} 00:00`;
    // Stored end is exclusive. Accept either the inclusive last day or an
    // exclusive midnight as returned by this API.
    const isExclusiveMidnight = String(input.end ?? '').length > 10 && lastDate > startDate;
    endTime = `${isExclusiveMidnight ? lastDate : addDays(lastDate, 1)} 00:00`;
  } else {
    const start = parseNaive(input.start);
    const end = parseNaive(input.end);
    if (!start) return { ok: false, error: 'start must be "YYYY-MM-DD HH:MM"' };
    if (!end) return { ok: false, error: 'end must be "YYYY-MM-DD HH:MM"' };
    startTime = start.text;
    endTime = end.text;
  }
  const minutes = naiveDiffMinutes(startTime, endTime);
  if (!(minutes > 0)) return { ok: false, error: 'end must be after start' };
  if (minutes > MAX_EVENT_MINUTES) return { ok: false, error: 'events can be at most 31 days long' };

  const recurrence = input.recurrence ? String(input.recurrence).trim() : null;
  if (recurrence && !validRRule(recurrence)) return { ok: false, error: 'recurrence must be an RRULE such as "FREQ=WEEKLY;BYDAY=MO"' };

  const notes = input.notes == null ? '' : String(input.notes);
  const location = input.location == null ? '' : String(input.location);
  if (notes.length > 2000) return { ok: false, error: 'notes must be under 2000 characters' };
  if (location.length > 300) return { ok: false, error: 'location must be under 300 characters' };
  const color = input.color == null ? '#6366F1' : String(input.color);
  if (!/^#[0-9a-f]{6}$/i.test(color)) return { ok: false, error: 'color must be a hex colour like #6366F1' };

  return { ok: true, fields: { title, allDay, startTime, endTime, recurrence, notes, location, color } };
}

/** Push this account's unsynced events to its Pod, in the background. */
function syncToPodInBackground(req) {
  (async () => {
    const fetch = await getAuthenticatedFetch(req.solidSession, req.user?.webId || req.session?.webId);
    const podUrl = await userPodUrl(req, fetch);
    if (!fetch || !podUrl) return;
    const result = await syncCalendarEventsToPod(podUrl, fetch, organizerTimezone(req.tenant), req.tenant.id);
    if (result.failed) console.warn(`[Calendar] ${result.failed} event(s) not yet synced to the Pod`);
  })().catch((err) => console.warn('[Calendar] Pod sync deferred to next login:', err.message));
}

async function userPodUrl(req, fetch) {
  const known = req.user?.pods?.[0] || req.session?.podUrl || req.tenant?.solid_pod_url;
  if (known) return known;
  if (!fetch) return null;
  const pods = await solidService.getUserPods(req.user?.webId || req.session?.webId, fetch).catch(() => []);
  return pods[0] || null;
}

router.get('/events', publicReadLimiter, requireAuth(), requireTenant, (req, res) => {
  const { from, to } = req.query;
  if (!DATE.test(from || '') || !DATE.test(to || '') || to < from) {
    return res.status(400).json({ error: 'from and to must be dates (YYYY-MM-DD), with to on or after from' });
  }
  if (naiveDiffMinutes(`${from} 00:00`, `${to} 00:00`) > MAX_RANGE_DAYS * 24 * 60) {
    return res.status(400).json({ error: `The range can be at most ${MAX_RANGE_DAYS} days` });
  }
  try {
    const rows = getCalendarEventsInRange(req.tenant.id, `${from} 00:00`, `${addDays(to, 1)} 00:00`);
    res.json({ timezone: organizerTimezone(req.tenant), events: rows.map(toApi) });
  } catch (err) {
    console.error('[Calendar] List events error:', err.message);
    res.status(500).json({ error: 'Failed to load calendar events' });
  }
});

router.post('/events', calendarWriteLimiter, requireAuth(), requireTenant, (req, res) => {
  const result = validateEvent(req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error });
  try {
    const { id } = createCalendarEvent(req.tenant.id, result.fields);
    syncToPodInBackground(req);
    res.status(201).json({ event: toApi(getCalendarEvent(req.tenant.id, id)) });
  } catch (err) {
    console.error('[Calendar] Create event error:', err.message);
    res.status(500).json({ error: 'Failed to create calendar event' });
  }
});

router.put('/events/:id', calendarWriteLimiter, requireAuth(), requireTenant, (req, res) => {
  const existing = getCalendarEvent(req.tenant.id, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Calendar event not found' });

  const current = toApi(existing);
  const body = req.body || {};
  const merged = { ...current };
  for (const key of ['title', 'start', 'end', 'allDay', 'recurrence', 'notes', 'location', 'color']) {
    if (key in body) merged[key] = body[key];
  }
  const result = validateEvent(merged);
  if (!result.ok) return res.status(400).json({ error: result.error });
  try {
    updateCalendarEvent(req.tenant.id, existing.id, result.fields);
    syncToPodInBackground(req);
    res.json({ event: toApi(getCalendarEvent(req.tenant.id, existing.id)) });
  } catch (err) {
    console.error('[Calendar] Update event error:', err.message);
    res.status(500).json({ error: 'Failed to update calendar event' });
  }
});

router.delete('/events/:id', calendarWriteLimiter, requireAuth(), requireTenant, async (req, res) => {
  const existing = getCalendarEvent(req.tenant.id, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Calendar event not found' });

  // An event already in the Pod must be removed there first: the Pod is
  // imported back at every login, so a local-only delete would not stick.
  if (existing.pod_url) {
    try {
      const fetch = await getAuthenticatedFetch(req.solidSession, req.user?.webId || req.session?.webId);
      const podUrl = await userPodUrl(req, fetch);
      if (!fetch || !podUrl) throw new Error('no Pod session');
      if (existing.pod_url.startsWith(podUrl)) {
        await solidService.removeCalendarEventFromPod(existing.pod_url, fetch);
      }
    } catch (err) {
      console.warn('[Calendar] Could not delete event from Pod:', err.message);
      return res.status(502).json({
        error: 'Could not remove this event from your Pod. Reconnect your Pod and try again.',
      });
    }
  }

  try {
    deleteCalendarEvent(req.tenant.id, existing.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Calendar] Delete event error:', err.message);
    res.status(500).json({ error: 'Failed to delete calendar event' });
  }
});

router.post(
  '/import',
  calendarWriteLimiter,
  requireAuth(),
  requireTenant,
  express.text({ type: ['text/calendar', 'text/plain'], limit: '2mb' }),
  (req, res) => {
    const ics = typeof req.body === 'string' ? req.body : req.body?.icsContent;
    if (typeof ics !== 'string' || !ics.includes('BEGIN:VCALENDAR')) {
      return res.status(400).json({ error: 'Send an iCalendar (.ics) file' });
    }

    const timezone = organizerTimezone(req.tenant);
    let parsed;
    try {
      parsed = parseICSCalendar(ics, { timezone });
    } catch (err) {
      return res.status(400).json({ error: 'Could not read this .ics file' });
    }
    if (parsed.length > MAX_IMPORT_EVENTS) {
      return res.status(413).json({ error: `Import at most ${MAX_IMPORT_EVENTS} events at a time` });
    }

    const todayStart = `${instantToNaive(new Date(), timezone).slice(0, 10)} 00:00`;
    const skipped = { past: 0, cancelled: 0, free: 0, duplicate: 0, invalid: 0 };
    let imported = 0;

    try {
      getDb().transaction(() => {
        for (const ev of parsed) {
          if (ev.status === 'CANCELLED') { skipped.cancelled++; continue; }
          if (ev.transparent) { skipped.free++; continue; }
          if (ev.uid && getCalendarEventByIcsUid(req.tenant.id, ev.uid)) { skipped.duplicate++; continue; }

          const recurrence = ev.rrule && validRRule(ev.rrule) ? ev.rrule : null;
          if (ev.rrule && !recurrence) { skipped.invalid++; continue; }
          if (!recurrence && ev.end <= todayStart) { skipped.past++; continue; }
          if (recurrence) {
            const rule = parseRRule(recurrence);
            if (rule?.until && rule.until < new Date()) { skipped.past++; continue; }
          }

          const minutes = naiveDiffMinutes(ev.start, ev.end);
          if (!(minutes > 0) || minutes > MAX_EVENT_MINUTES) { skipped.invalid++; continue; }

          createCalendarEvent(req.tenant.id, {
            title: (ev.title || 'Busy').slice(0, 200),
            startTime: ev.start,
            endTime: ev.end,
            allDay: ev.allDay,
            recurrence,
            notes: (ev.description || '').slice(0, 2000),
            location: (ev.location || '').slice(0, 300),
            icsUid: ev.uid ? String(ev.uid).slice(0, 500) : null,
          });
          imported++;
        }
      })();
    } catch (err) {
      console.error('[Calendar] Import error:', err.message);
      return res.status(500).json({ error: 'Import failed; nothing was imported' });
    }

    if (imported > 0) syncToPodInBackground(req);
    res.json({ imported, skipped, timezone });
  },
);

export default router;
