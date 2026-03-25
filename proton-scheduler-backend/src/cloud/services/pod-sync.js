/**
 * Pod Sync Service
 *
 * Syncs bookings from the SQLite queue to the organizer's Solid Pod.
 * SQLite acts as a temporary inbox; the Pod is the source of truth.
 *
 * Flow:
 * 1. Visitor books → booking saved to SQLite (synced_to_pod = 0)
 * 2. Organizer logs in → syncBookingsToPod() runs
 * 3. Each unsynced booking is written to Pod as RDF/Turtle
 * 4. SQLite record marked synced_to_pod = 1, pod_url = resource URL
 * 5. Old synced records can be cleared (Pod has the data)
 */

import { getUnsyncedBookings, markBookingSynced } from '../models/bookings-db.js';
import { getUnsyncedCalendarEvents, markCalendarEventSynced } from '../models/calendar-events-db.js';
import solidService from '../../services/solid.js';

/**
 * Convert a naive local time (from SQLite) to a proper UTC ISO string.
 * SQLite stores times in the organizer's local timezone without offset info.
 * On a UTC server, `new Date(y, m, d, h, min)` wrongly treats these as UTC.
 * This function correctly interprets the naive time in the given timezone.
 *
 * @param {number} year
 * @param {number} month - 1-based (1 = January)
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {string} timezone - IANA timezone (e.g. 'Europe/Paris')
 * @returns {string} ISO 8601 UTC string
 */
function naiveLocalToISO(year, month, day, hour, minute, timezone) {
  // Step 1: Treat the naive time as if it were UTC (starting point)
  const naiveAsUTC = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Step 2: Find what local time that UTC instant maps to in the target timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(naiveAsUTC));
  const get = (type) => parseInt(parts.find(p => p.type === type).value);

  // Step 3: Compute the timezone offset at this moment
  const h = get('hour') === 24 ? 0 : get('hour');
  const localAsUTC = Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'), get('second'));
  const offsetMs = localAsUTC - naiveAsUTC;

  // Step 4: The correct UTC = naive time (as UTC) minus the offset
  return new Date(naiveAsUTC - offsetMs).toISOString();
}

/**
 * Sync all unsynced bookings to the organizer's Pod
 * @param {string} podUrl - Organizer's Pod URL
 * @param {Function} fetch - Authenticated fetch function from Solid session
 * @param {string} timezone - Organizer's IANA timezone (e.g. 'Europe/Paris')
 * @returns {Object} Sync results
 */
export async function syncBookingsToPod(podUrl, fetch, timezone = 'Europe/Paris') {
  const unsynced = getUnsyncedBookings(null);

  if (unsynced.length === 0) {
    return { synced: 0, failed: 0, total: 0 };
  }

  console.log(`[Pod Sync] Starting sync: ${unsynced.length} bookings to push to Pod`);

  let synced = 0;
  let failed = 0;

  for (const booking of unsynced) {
    try {
      // Parse our stored date format "YYYY-MM-DD HH:MM" into proper dates
      const [datePart, timePart] = booking.start_time.split(' ');
      const [endDatePart, endTimePart] = booking.end_time.split(' ');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hour, minute] = timePart.split(':').map(Number);
      const [endYear, endMonth, endDay] = endDatePart.split('-').map(Number);
      const [endHour, endMinute] = endTimePart.split(':').map(Number);

      // Convert naive local times to correct UTC ISO strings
      // SQLite stores times in the organizer's local timezone (e.g. "09:30" means 09:30 CET)
      // On a UTC server, new Date(y,m,d,h,m) would wrongly treat 09:30 as UTC
      const startISO = naiveLocalToISO(year, month, day, hour, minute, timezone);
      const endISO = naiveLocalToISO(endYear, endMonth, endDay, endHour, endMinute, timezone);

      // Build booking object matching what solid.js expects
      const podBooking = {
        id: booking.id,
        title: booking.title,
        start: startISO,
        end: endISO,
        description: booking.notes || '',
        location: booking.location || 'Video Call',
        organizer: {
          name: process.env.ORGANIZER_NAME || 'Organizer',
          email: process.env.ORGANIZER_EMAIL || '',
        },
        attendee: {
          name: booking.attendee_name,
          email: booking.attendee_email,
        },
        notes: booking.notes || '',
        confirmationSent: true,
      };

      // Write to Pod
      const podResourceUrl = await solidService.saveBooking(podUrl, podBooking, fetch);

      // Mark as synced in SQLite
      markBookingSynced(booking.id, podResourceUrl);
      synced++;

      console.log(`[Pod Sync] ✓ Synced: ${booking.title} → ${podResourceUrl}`);
    } catch (err) {
      failed++;
      console.error(`[Pod Sync] ✗ Failed to sync ${booking.id}:`, err.message);
    }
  }

  console.log(`[Pod Sync] Complete: ${synced} synced, ${failed} failed out of ${unsynced.length}`);

  return { synced, failed, total: unsynced.length };
}

/**
 * Load bookings from Pod (source of truth) with SQLite fallback
 * @param {string} podUrl - Organizer's Pod URL
 * @param {Function} fetch - Authenticated fetch function
 * @param {Object} options - Filter options
 * @returns {Array} Bookings array
 */
export async function loadBookingsWithFallback(podUrl, fetch, options = {}) {
  try {
    // Try Pod first (source of truth)
    const podBookings = await solidService.loadBookings(podUrl, fetch, options);

    if (podBookings.length > 0) {
      console.log(`[Pod Sync] Loaded ${podBookings.length} bookings from Pod`);
      return { source: 'pod', bookings: podBookings };
    }

    // Fallback to SQLite (might have unsynced bookings)
    console.log('[Pod Sync] No Pod bookings found, falling back to SQLite');
    return { source: 'sqlite', bookings: [] };
  } catch (err) {
    console.warn('[Pod Sync] Pod read failed, using SQLite fallback:', err.message);
    return { source: 'sqlite', bookings: [] };
  }
}

/**
 * Sync all unsynced calendar events to the organizer's Pod.
 * Same pattern as syncBookingsToPod — SQLite inbox → Pod source of truth.
 *
 * @param {string} podUrl
 * @param {Function} fetch — Authenticated fetch from Solid session
 * @param {string} timezone — IANA timezone (e.g. 'Europe/Paris')
 * @param {string} [tenantId] — Optional tenant filter
 * @returns {Object} { synced, failed, total }
 */
export async function syncCalendarEventsToPod(podUrl, fetch, timezone = 'Europe/Paris', tenantId = null) {
  const unsynced = getUnsyncedCalendarEvents(tenantId);

  if (unsynced.length === 0) {
    return { synced: 0, failed: 0, total: 0 };
  }

  console.log(`[Pod Sync] Starting calendar event sync: ${unsynced.length} events to push`);

  let synced = 0;
  let failed = 0;

  for (const event of unsynced) {
    try {
      // Parse naive local time → UTC ISO
      const [datePart, timePart] = event.start_time.split(' ');
      const [endDatePart, endTimePart] = event.end_time.split(' ');
      const [year, month, day] = datePart.split('-').map(Number);
      const [hour, minute] = timePart.split(':').map(Number);
      const [endYear, endMonth, endDay] = endDatePart.split('-').map(Number);
      const [endHour, endMinute] = endTimePart.split(':').map(Number);

      const startISO = naiveLocalToISO(year, month, day, hour, minute, timezone);
      const endISO = naiveLocalToISO(endYear, endMonth, endDay, endHour, endMinute, timezone);

      const podEvent = {
        id: event.id,
        title: event.title,
        start: startISO,
        end: endISO,
        allDay: !!event.all_day,
        recurrence: event.recurrence || null,
        color: event.color || '#219EBC',
        category: event.category || 'default',
        notes: event.notes || '',
        location: event.location || '',
      };

      const podResourceUrl = await solidService.saveCalendarEvent(podUrl, podEvent, fetch);
      markCalendarEventSynced(event.id, podResourceUrl);
      synced++;

      console.log(`[Pod Sync] ✓ Synced calendar event: ${event.title} → ${podResourceUrl}`);
    } catch (err) {
      failed++;
      console.error(`[Pod Sync] ✗ Failed to sync calendar event ${event.id}:`, err.message);
    }
  }

  console.log(`[Pod Sync] Calendar events complete: ${synced} synced, ${failed} failed out of ${unsynced.length}`);
  return { synced, failed, total: unsynced.length };
}

/**
 * Load calendar events from Pod with SQLite fallback.
 */
export async function loadCalendarEventsWithFallback(podUrl, fetch, options = {}) {
  try {
    const podEvents = await solidService.loadCalendarEvents(podUrl, fetch, options);
    if (podEvents.length > 0) {
      console.log(`[Pod Sync] Loaded ${podEvents.length} calendar events from Pod`);
      return { source: 'pod', events: podEvents };
    }
    return { source: 'sqlite', events: [] };
  } catch (err) {
    console.warn('[Pod Sync] Calendar events Pod read failed, using SQLite fallback:', err.message);
    return { source: 'sqlite', events: [] };
  }
}

/**
 * Import events from Pod into SQLite (runs on login).
 * Upserts by UUID/ics_uid — events already in SQLite are skipped.
 * New events from Pod are inserted with synced_to_pod = 1.
 */
export async function importPodEventsToSQLite(podUrl, fetch, tenantId, timezone = 'Europe/Paris') {
  let imported = { bookings: 0, calendarEvents: 0 };

  try {
    // Import calendar events from Pod
    const podEvents = await solidService.loadCalendarEvents(podUrl, fetch);
    const { getCalendarEvent, createCalendarEvent } = await import('../models/calendar-events-db.js');
    const { getDb } = await import('../models/database.js');

    for (const pe of podEvents) {
      try {
        // Check if already in SQLite by UUID
        const existing = pe.id ? getCalendarEvent(tenantId, pe.id) : null;
        if (existing) continue;

        // Convert UTC ISO times from Pod to naive local times for SQLite
        const startLocal = utcISOToNaiveLocal(pe.start, timezone);
        const endLocal = utcISOToNaiveLocal(pe.end, timezone);
        if (!startLocal || !endLocal) continue;

        createCalendarEvent(tenantId, {
          id: pe.id,
          title: pe.title,
          startTime: startLocal,
          endTime: endLocal,
          allDay: pe.allDay || false,
          recurrence: pe.recurrence || null,
          color: pe.color || '#219EBC',
          category: pe.category || 'default',
          notes: pe.notes || '',
          location: pe.location || '',
          icsUid: pe.ics_uid || null,
        });

        // Mark as already synced (it came from the Pod)
        const db = getDb();
        db.prepare('UPDATE calendar_events SET synced_to_pod = 1, pod_url = ? WHERE id = ? AND tenant_id = ?')
          .run(pe.url || '', pe.id, tenantId);

        imported.calendarEvents++;
      } catch (err) {
        console.warn(`[Pod Import] Failed to import calendar event ${pe.title}:`, err.message);
      }
    }

    if (imported.calendarEvents > 0) {
      console.log(`[Pod Import] Imported ${imported.calendarEvents} calendar events from Pod`);
    }
  } catch (err) {
    console.warn('[Pod Import] Calendar events import failed:', err.message);
  }

  return imported;
}

/**
 * Convert a UTC ISO string to a naive local time string for SQLite.
 * Reverse of naiveLocalToISO.
 * @param {string} isoString - UTC ISO string (e.g. "2026-03-24T07:30:00.000Z")
 * @param {string} timezone - IANA timezone (e.g. 'Europe/Paris')
 * @returns {string} "YYYY-MM-DD HH:MM" in local time
 */
function utcISOToNaiveLocal(isoString, timezone) {
  if (!isoString) return null;
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return null;
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    return null;
  }
}

export default {
  syncBookingsToPod,
  loadBookingsWithFallback,
  syncCalendarEventsToPod,
  loadCalendarEventsWithFallback,
  importPodEventsToSQLite,
};
