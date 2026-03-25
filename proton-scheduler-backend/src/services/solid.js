/**
 * Solid Pod Service — Thin wrapper around @zerolimit/solid-pod-sync
 *
 * Injects ProtonScheduler's config.pod paths so existing consumers don't need
 * to pass pathConfig on every call.
 *
 * Also includes calendar event Pod operations (saveCalendarEvent,
 * loadCalendarEvents, deleteCalendarEventFromPod) implemented directly
 * with the Inrupt SDK since the core package doesn't include them yet.
 */

import config from '../config/index.js';
import {
  getSchedulerPaths as _getSchedulerPaths,
  initializeSchedulerContainer as _initializeSchedulerContainer,
  saveAvailability as _saveAvailability,
  loadAvailability as _loadAvailability,
  saveBooking as _saveBooking,
  loadBookings as _loadBookings,
  cancelBooking,
  deleteBooking,
  addExcludedDate,
  updateRecurringSeries,
  setupPublicBookingPage as _setupPublicBookingPage,
  getUserPods,
  checkSlotConflict as _checkSlotConflict,
} from '@zerolimit/packages/solid-pod-sync/core';

// Inrupt SDK — for calendar event operations
import {
  getSolidDataset,
  saveSolidDatasetAt,
  createSolidDataset,
  createThing,
  setThing,
  getThingAll,
  getUrl,
  getStringNoLocale,
  getBoolean,
  getDatetime,
  setUrl,
  setStringNoLocale,
  setBoolean,
  setDatetime,
  createContainerAt,
  getContainedResourceUrlAll,
  deleteFile,
} from '@inrupt/solid-client';

import { SCHEMA, SCHED } from '../utils/rdf.js';
import { buildRRule } from '../utils/rrule.js';

const podPaths = config.pod;

// Bind ProtonScheduler's path config into every function
export function getSchedulerPaths(podUrl) {
  return _getSchedulerPaths(podUrl, podPaths);
}

export function initializeSchedulerContainer(podUrl, fetch) {
  return _initializeSchedulerContainer(podUrl, fetch, podPaths);
}

export function saveAvailability(podUrl, availability, fetch) {
  return _saveAvailability(podUrl, availability, fetch, podPaths);
}

export function loadAvailability(podUrl, fetch) {
  return _loadAvailability(podUrl, fetch, podPaths);
}

export function saveBooking(podUrl, booking, fetch) {
  return _saveBooking(podUrl, booking, fetch, podPaths);
}

export function loadBookings(podUrl, fetch, options = {}) {
  return _loadBookings(podUrl, fetch, options, podPaths);
}

export function setupPublicBookingPage(podUrl, publicInfo, fetch) {
  return _setupPublicBookingPage(podUrl, publicInfo, fetch, podPaths);
}

export function checkSlotConflict(podUrl, start, end, fetch) {
  return _checkSlotConflict(podUrl, start, end, fetch, podPaths);
}

// Re-export functions that don't need path config
export { cancelBooking, deleteBooking, addExcludedDate, updateRecurringSeries, getUserPods };

// =============================================================================
// Calendar Events — Pod operations
// =============================================================================

/** Custom SCHED predicates for calendar events (not yet in @zerolimit/packages) */
const CAL_SCHED = {
  CalendarEvent: `${SCHED.Booking.replace('Booking', 'CalendarEvent')}`,
  allDay:        `${SCHED.isRecurring.replace('isRecurring', 'allDay')}`,
  color:         `${SCHED.isRecurring.replace('isRecurring', 'color')}`,
  category:      `${SCHED.isRecurring.replace('isRecurring', 'category')}`,
};

const CALENDAR_EVENTS_CONTAINER = 'calendar-events';

/** Get the calendar-events container URL for a Pod */
function getCalendarEventsPath(podUrl) {
  const paths = getSchedulerPaths(podUrl);
  return `${paths.root}${CALENDAR_EVENTS_CONTAINER}/`;
}

/**
 * Save a calendar event to the Pod.
 * Idempotent — skips if the resource already exists.
 *
 * @param {string} podUrl
 * @param {Object} event — { id, title, start, end, allDay, recurrence, color, category, notes, location }
 * @param {Function} fetch — Authenticated fetch
 * @returns {string} Pod resource URL
 */
export async function saveCalendarEvent(podUrl, event, fetch) {
  const containerUrl = getCalendarEventsPath(podUrl);

  // Ensure container exists
  try {
    await createContainerAt(containerUrl, { fetch });
  } catch {
    // Container already exists
  }

  const eventId = event.id || `event-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const eventUrl = `${containerUrl}${eventId}.ttl`;

  // Idempotent: skip if exists
  try {
    await getSolidDataset(eventUrl, { fetch });
    console.log(`[Solid] Calendar event ${eventId} already exists on Pod, skipping write`);
    return eventUrl;
  } catch {
    // 404 = doesn't exist, proceed
  }

  let dataset = createSolidDataset();
  const thingUrl = `${eventUrl}#event`;
  let thing = createThing({ url: thingUrl });

  // Types
  thing = setUrl(thing, `${SCHEMA.name}Type`, CAL_SCHED.CalendarEvent);
  thing = setUrl(thing, `${SCHEMA.name}additionalType`, SCHEMA.Event);

  // Core fields
  thing = setStringNoLocale(thing, SCHEMA.identifier, eventId);
  thing = setStringNoLocale(thing, SCHEMA.name, event.title);
  thing = setDatetime(thing, SCHEMA.startDate, new Date(event.start));
  thing = setDatetime(thing, SCHEMA.endDate, new Date(event.end));

  // Calendar-specific fields
  thing = setBoolean(thing, CAL_SCHED.allDay, !!event.allDay);
  if (event.color) thing = setStringNoLocale(thing, CAL_SCHED.color, event.color);
  if (event.category) thing = setStringNoLocale(thing, CAL_SCHED.category, event.category);

  // Optional fields
  if (event.notes) thing = setStringNoLocale(thing, SCHEMA.description, event.notes);
  if (event.location) thing = setStringNoLocale(thing, SCHEMA.location, event.location);

  // Recurrence
  if (event.recurrence) {
    thing = setBoolean(thing, SCHED.isRecurring, true);
    thing = setStringNoLocale(thing, SCHED.rruleString, event.recurrence);
  } else {
    thing = setBoolean(thing, SCHED.isRecurring, false);
  }

  // Metadata
  thing = setDatetime(thing, SCHEMA.dateCreated, new Date());

  dataset = setThing(dataset, thing);
  await saveSolidDatasetAt(eventUrl, dataset, { fetch });

  return eventUrl;
}

/**
 * Load all calendar events from the Pod.
 *
 * @param {string} podUrl
 * @param {Function} fetch — Authenticated fetch
 * @param {Object} [options] — { from, to } date range filters
 * @returns {Array} Parsed calendar events
 */
export async function loadCalendarEvents(podUrl, fetch, options = {}) {
  const containerUrl = getCalendarEventsPath(podUrl);
  const events = [];

  try {
    const container = await getSolidDataset(containerUrl, { fetch });
    const resourceUrls = getContainedResourceUrlAll(container);

    for (const url of resourceUrls) {
      if (!url.endsWith('.ttl')) continue;
      try {
        const dataset = await getSolidDataset(url, { fetch });
        const things = getThingAll(dataset);

        for (const thing of things) {
          const typeUrl = getUrl(thing, `${SCHEMA.name}Type`);
          if (typeUrl !== CAL_SCHED.CalendarEvent) continue;

          const event = {
            id: getStringNoLocale(thing, SCHEMA.identifier),
            title: getStringNoLocale(thing, SCHEMA.name),
            start: getDatetime(thing, SCHEMA.startDate)?.toISOString(),
            end: getDatetime(thing, SCHEMA.endDate)?.toISOString(),
            allDay: getBoolean(thing, CAL_SCHED.allDay) || false,
            color: getStringNoLocale(thing, CAL_SCHED.color) || '#219EBC',
            category: getStringNoLocale(thing, CAL_SCHED.category) || 'default',
            notes: getStringNoLocale(thing, SCHEMA.description) || '',
            location: getStringNoLocale(thing, SCHEMA.location) || '',
            isRecurring: getBoolean(thing, SCHED.isRecurring) || false,
            recurrence: getStringNoLocale(thing, SCHED.rruleString) || null,
            url,
          };

          // Date range filtering
          if (options.from && event.start && event.start < options.from && !event.isRecurring) continue;
          if (options.to && event.start && event.start > options.to && !event.isRecurring) continue;

          events.push(event);
        }
      } catch (err) {
        console.warn(`[Solid] Failed to read calendar event ${url}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[Solid] Failed to load calendar events container:', err.message);
  }

  return events;
}

/**
 * Delete a calendar event from the Pod.
 * @param {string} eventUrl — Full Pod resource URL
 * @param {Function} fetch — Authenticated fetch
 */
export async function deleteCalendarEventFromPod(eventUrl, fetch) {
  try {
    await deleteFile(eventUrl, { fetch });
    console.log(`[Solid] Deleted calendar event: ${eventUrl}`);
  } catch (err) {
    console.warn(`[Solid] Failed to delete calendar event ${eventUrl}:`, err.message);
  }
}

export default {
  getSchedulerPaths,
  initializeSchedulerContainer,
  saveAvailability,
  loadAvailability,
  saveBooking,
  loadBookings,
  cancelBooking,
  deleteBooking,
  addExcludedDate,
  updateRecurringSeries,
  setupPublicBookingPage,
  getUserPods,
  checkSlotConflict,
  saveCalendarEvent,
  loadCalendarEvents,
  deleteCalendarEventFromPod,
};
