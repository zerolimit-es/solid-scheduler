/**
 * ICS Calendar Feed Route (Public, no auth)
 *
 * GET /cal/:token.ics
 *
 * Serves a subscribable ICS feed containing all bookings + calendar events
 * for a tenant. Token-based auth (the URL IS the secret).
 *
 * Proton Calendar (and any other app) can subscribe to this URL
 * and poll it periodically to stay in sync.
 */

import { Router } from 'express';
import { getTenantByFeedToken, getCalendarEventsInRange } from '../cloud/models/calendar-events-db.js';
import { getBookingsBySlug } from '../cloud/models/bookings-db.js';
import { getDb } from '../cloud/models/database.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

/**
 * GET /cal/:token.ics — Public ICS feed
 */
router.get('/:token.ics', (req, res) => {
  try {
    const token = req.params.token;
    const tenantId = getTenantByFeedToken(token);

    if (!tenantId) {
      return res.status(404).send('Feed not found');
    }

    // Look up tenant for metadata
    const db = getDb();
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) return res.status(404).send('Feed not found');

    const calName = tenant.company_name || tenant.email || 'ProtonScheduler Calendar';
    const slug = tenant.booking_slug;

    // Get bookings (upcoming, last 30 days, next 90 days)
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - 30);
    const to = new Date(now);
    to.setDate(to.getDate() + 90);

    const fromStr = formatDate(from);
    const toStr = formatDate(to);

    // Fetch bookings from SQLite (no auth session for Pod)
    const bookings = slug
      ? db.prepare(
          `SELECT * FROM bookings WHERE slug = ? AND start_time >= ? AND start_time <= ? AND status = 'confirmed' ORDER BY start_time`
        ).all(slug, `${fromStr} 00:00`, `${toStr} 23:59`)
      : [];

    // Fetch calendar events
    const calEvents = getCalendarEventsInRange(tenantId, `${fromStr} 00:00`, `${toStr} 23:59`);

    // Build VCALENDAR
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ProtonScheduler//Calendar Feed//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeICS(calName)}`,
      'X-WR-TIMEZONE:UTC',
    ];

    // Add bookings as VEVENTs
    for (const b of bookings) {
      lines.push(...bookingToVEvent(b));
    }

    // Add calendar events as VEVENTs
    for (const e of calEvents) {
      lines.push(...calEventToVEvent(e));
    }

    lines.push('END:VCALENDAR');

    const icsContent = lines.join('\r\n');

    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="calendar.ics"',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.send(icsContent);
  } catch (err) {
    console.error('[Calendar Feed] Error:', err);
    res.status(500).send('Internal Server Error');
  }
});

function bookingToVEvent(b) {
  const uid = `booking-${b.id}@protonscheduler.local`;
  const dtstart = naiveToICSDate(b.start_time);
  const dtend = naiveToICSDate(b.end_time);
  const created = b.created_at ? dateToICS(new Date(b.created_at)) : dateToICS(new Date());

  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${dtstart}`,
    `DTEND:${dtend}`,
    `DTSTAMP:${created}`,
    `SUMMARY:${escapeICS(b.title)}`,
    b.location ? `LOCATION:${escapeICS(b.location)}` : null,
    b.notes ? `DESCRIPTION:${escapeICS(b.notes)}` : null,
    `CATEGORIES:Booking`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
  ].filter(Boolean);
}

function calEventToVEvent(e) {
  const uid = e.ics_uid || `calevent-${e.id}@protonscheduler.local`;
  const dtstart = e.all_day ? naiveToICSDateOnly(e.start_time) : naiveToICSDate(e.start_time);
  const dtend = e.all_day ? naiveToICSDateOnly(e.end_time) : naiveToICSDate(e.end_time);
  const created = e.created_at ? dateToICS(new Date(e.created_at)) : dateToICS(new Date());

  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    e.all_day ? `DTSTART;VALUE=DATE:${dtstart}` : `DTSTART:${dtstart}`,
    e.all_day ? `DTEND;VALUE=DATE:${dtend}` : `DTEND:${dtend}`,
    `DTSTAMP:${created}`,
    `SUMMARY:${escapeICS(e.title)}`,
  ];

  if (e.location) lines.push(`LOCATION:${escapeICS(e.location)}`);
  if (e.notes) lines.push(`DESCRIPTION:${escapeICS(e.notes)}`);
  if (e.recurrence) lines.push(`RRULE:${e.recurrence}`);
  if (e.category && e.category !== 'default') lines.push(`CATEGORIES:${escapeICS(e.category)}`);

  lines.push('END:VEVENT');
  return lines;
}

// Helpers

function escapeICS(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Convert "YYYY-MM-DD HH:MM" → "YYYYMMDDTHHMMSS" (naive, no timezone) */
function naiveToICSDate(naiveStr) {
  if (!naiveStr) return '';
  const [date, time] = naiveStr.split(' ');
  const [y, m, d] = date.split('-');
  const [h, min] = (time || '00:00').split(':');
  return `${y}${m}${d}T${h}${min}00`;
}

/** Convert "YYYY-MM-DD HH:MM" → "YYYYMMDD" for all-day events */
function naiveToICSDateOnly(naiveStr) {
  if (!naiveStr) return '';
  const [date] = naiveStr.split(' ');
  return date.replace(/-/g, '');
}

function dateToICS(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default router;
