/**
 * CalDAV sync: copy one account's bookings to an external CalDAV calendar
 * (Nextcloud, Radicale, Baikal, ...).
 *
 * Configured by the operator in .env (see SELF-HOSTING.md). Only bookings on
 * the booking page named by CALDAV_BOOKING_SLUG are synced, so on an instance
 * with several accounts nobody else's bookings or attendee details reach the
 * operator's calendar.
 *
 * Each booking is one calendar object resource, `<collection>/<id>.ics`:
 * created with PUT, removed with DELETE (RFC 4791). Sync runs in the
 * background and never fails or delays the booking itself.
 */

import config from '../config/index.js';
import { buildRRule } from '../utils/rrule.js';
import { naiveLocalToISO } from '../cloud/services/pod-sync.js';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Validate and normalise the operator's settings.
 * @returns {{ ok: true, settings: object } | { ok: false, reason: string }}
 */
export function resolveSettings(raw = config.caldav) {
  if (!raw?.enabled) return { ok: false, reason: 'disabled' };

  let url;
  try {
    url = new URL(raw.serverUrl);
  } catch {
    return { ok: false, reason: 'CALDAV_SERVER_URL is not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'CALDAV_SERVER_URL must be an http(s) URL' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'Put the CalDAV credentials in CALDAV_USERNAME/CALDAV_PASSWORD, not in the URL' };
  }
  if (!raw.bookingSlug) {
    return { ok: false, reason: 'CALDAV_BOOKING_SLUG is required: it names the account whose bookings are synced' };
  }
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';

  return {
    ok: true,
    settings: {
      collectionUrl: url.href,
      username: raw.username || '',
      password: raw.password || '',
      bookingSlug: String(raw.bookingSlug).toLowerCase(),
      insecure: url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    },
  };
}

// ── iCalendar ─────────────────────────────────────────────────────────────

function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function toUTCStamp(date) {
  return new Date(date).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Fold lines longer than 75 octets (RFC 5545 §3.1). */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Don't split a multi-byte UTF-8 character.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // continuation lines start with a space
  }
  return parts.join('\r\n ');
}

/** Stable resource name for a booking ID: safe in a URL path segment. */
export function resourceName(bookingId) {
  return `${String(bookingId).replace(/[^A-Za-z0-9._-]/g, '_')}.ics`;
}

/**
 * Build the calendar object for a booking. A stored CalDAV resource must not
 * contain METHOD (RFC 4791 §4.1), so this is not the invitation ICS.
 *
 * @param {object} booking
 * @param {string} booking.id
 * @param {string} booking.title
 * @param {string|Date} booking.start  Absolute instant (ISO string or Date)
 * @param {string|Date} booking.end
 * @param {string} [booking.attendeeName]
 * @param {string} [booking.attendeeEmail]
 * @param {string} [booking.notes]
 * @param {string} [booking.location]
 * @param {object} [booking.recurrence] Structured rule, see buildRRule()
 */
export function buildEventICS(booking, { now = new Date() } = {}) {
  const description = [
    'Booked via SolidScheduler',
    booking.attendeeName ? `Attendee: ${booking.attendeeName}` : null,
    booking.attendeeEmail ? `Email: ${booking.attendeeEmail}` : null,
    booking.notes ? `Notes: ${booking.notes}` : null,
  ].filter(Boolean).join('\n');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SolidScheduler//CalDAV Sync//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${booking.id}@solidscheduler`,
    `DTSTAMP:${toUTCStamp(now)}`,
    `DTSTART:${toUTCStamp(booking.start)}`,
    `DTEND:${toUTCStamp(booking.end)}`,
    `SUMMARY:${escapeText(booking.title || 'Meeting')}`,
    `DESCRIPTION:${escapeText(description)}`,
    `LOCATION:${escapeText(booking.location || 'Video Call')}`,
    'STATUS:CONFIRMED',
  ];
  if (booking.recurrence) lines.push(`RRULE:${buildRRule(booking.recurrence)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** "YYYY-MM-DD HH:MM" in the organizer's timezone → ISO instant. */
export function naiveToISO(naive, timezone) {
  const [datePart, timePart = '00:00'] = String(naive).split(' ');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  return naiveLocalToISO(y, mo, d, h, mi, timezone || 'UTC');
}

// ── Client ────────────────────────────────────────────────────────────────

/**
 * @param {object} [options]
 * @param {object} [options.settings] Raw settings (defaults to config.caldav)
 * @param {typeof fetch} [options.fetch]
 * @param {Console} [options.logger]
 */
export function createCaldavSync(options = {}) {
  const resolved = resolveSettings(options.settings ?? config.caldav);
  const doFetch = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? console;

  if (resolved.ok && resolved.settings.insecure) {
    logger.warn('[CalDAV] CALDAV_SERVER_URL uses plain http: your CalDAV password is sent unencrypted');
  }
  if (!resolved.ok && resolved.reason !== 'disabled') {
    logger.warn(`[CalDAV] Sync is off: ${resolved.reason}`);
  }

  const settings = resolved.ok ? resolved.settings : null;

  function appliesTo(slug) {
    return !!settings && typeof slug === 'string' && slug.toLowerCase() === settings.bookingSlug;
  }

  function request(method, bookingId, body) {
    const headers = {
      Authorization: `Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}`,
    };
    if (body) headers['Content-Type'] = 'text/calendar; charset=utf-8';
    return doFetch(new URL(resourceName(bookingId), settings.collectionUrl).href, {
      method,
      headers,
      body,
      redirect: 'error', // never replay the credentials to another host
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /** Create or replace the event for a booking. Resolves to true when written. */
  async function putBooking(slug, booking) {
    if (!appliesTo(slug)) return false;
    const res = await request('PUT', booking.id, buildEventICS(booking));
    if (!res.ok) throw new Error(`PUT ${resourceName(booking.id)} failed: HTTP ${res.status}`);
    return true;
  }

  /** Remove the event for a booking. A missing event counts as removed. */
  async function deleteBooking(slug, bookingId) {
    if (!appliesTo(slug)) return false;
    const res = await request('DELETE', bookingId);
    if (!res.ok && res.status !== 404) {
      throw new Error(`DELETE ${resourceName(bookingId)} failed: HTTP ${res.status}`);
    }
    return true;
  }

  /** Fire-and-forget wrappers for routes: log failures, never throw. */
  function bookingCreated(slug, booking) {
    if (!appliesTo(slug)) return Promise.resolve(false);
    return putBooking(slug, booking)
      .then((ok) => { if (ok) logger.log(`[CalDAV] Synced booking ${booking.id}`); return ok; })
      .catch((err) => { logger.warn(`[CalDAV] Could not sync booking ${booking.id}: ${err.message}`); return false; });
  }

  function bookingCancelled(slug, bookingId) {
    if (!appliesTo(slug)) return Promise.resolve(false);
    return deleteBooking(slug, bookingId)
      .then((ok) => { if (ok) logger.log(`[CalDAV] Removed booking ${bookingId}`); return ok; })
      .catch((err) => { logger.warn(`[CalDAV] Could not remove booking ${bookingId}: ${err.message}`); return false; });
  }

  return { enabled: !!settings, appliesTo, putBooking, deleteBooking, bookingCreated, bookingCancelled };
}

let defaultSync;
/** The instance configured from .env, created on first use. */
export function caldav() {
  defaultSync ??= createCaldavSync();
  return defaultSync;
}
