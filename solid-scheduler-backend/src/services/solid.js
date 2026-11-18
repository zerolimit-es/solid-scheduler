/**
 * Solid Pod Service — Thin wrapper around @zerolimit/solid-pod-sync
 *
 * Injects SolidScheduler's config.pod paths so existing consumers don't need
 * to pass pathConfig on every call.
 *
 * Also includes calendar event Pod operations (saveCalendarEvent,
 * loadCalendarEvents, deleteCalendarEventFromPod) implemented directly
 * with the Inrupt SDK since the core package doesn't include them yet.
 */

import crypto from 'crypto';
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
  getUserPods as _getUserPods,
  checkSlotConflict as _checkSlotConflict,
} from '@zerolimit/packages/solid-pod-sync/core';
import { hostPolicy } from './host-policy.js';

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

const podPaths = config.pod;

// Bind SolidScheduler's path config into every function
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

export function checkSlotConflict(podUrl, start, end, fetch, options = {}) {
  return _checkSlotConflict(podUrl, start, end, fetch, podPaths, options);
}

/**
 * Change a booking's title, description or location in place. Works for
 * one-off and recurring bookings alike.
 */
export function updateBookingDetails(bookingUrl, updates, fetch) {
  return updateRecurringSeries(bookingUrl, updates, fetch);
}

/** Record in the Pod that a booking's confirmation email was sent. */
export async function markConfirmationSent(bookingUrl, fetch) {
  const dataset = await getSolidDataset(bookingUrl, { fetch });
  let updated = dataset;
  for (const thing of getThingAll(dataset)) {
    if (getUrl(thing, `${SCHEMA.name}Type`) !== SCHED.Booking) continue;
    updated = setThing(updated, setBoolean(thing, SCHED.confirmationSent, true));
  }
  await saveSolidDatasetAt(bookingUrl, updated, { fetch });
}

// Re-export functions that don't need path config
export { cancelBooking, deleteBooking, addExcludedDate, updateRecurringSeries };

/**
 * The user's Pods as their WebID profile lists them, without any on an
 * address the server may not contact (see services/host-policy.js).
 */
export async function getUserPods(webId, fetch) {
  return hostPolicy.filterAllowed(await _getUserPods(webId, fetch));
}

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

/** How many Pod resources are read at once. */
const POD_READ_CONCURRENCY = 8;

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

  const eventId = event.id || `event-${crypto.randomUUID()}`;
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
    const resourceUrls = getContainedResourceUrlAll(container).filter((url) => url.endsWith('.ttl'));

    const readEvents = async (url) => {
      const found = [];
      try {
        const dataset = await getSolidDataset(url, { fetch });
        for (const thing of getThingAll(dataset)) {
          const typeUrl = getUrl(thing, `${SCHEMA.name}Type`);
          if (typeUrl !== CAL_SCHED.CalendarEvent) continue;

          const event = {
            id: getStringNoLocale(thing, SCHEMA.identifier),
            title: getStringNoLocale(thing, SCHEMA.name),
            start: getDatetime(thing, SCHEMA.startDate)?.toISOString(),
            end: getDatetime(thing, SCHEMA.endDate)?.toISOString(),
            allDay: getBoolean(thing, CAL_SCHED.allDay) || false,
            color: getStringNoLocale(thing, CAL_SCHED.color) || '#6366F1',
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

          found.push(event);
        }
      } catch (err) {
        console.warn(`[Solid] Failed to read calendar event ${url}:`, err.message);
      }
      return found;
    };

    // Several at a time, not one after another, in the Pod's listing order
    for (let i = 0; i < resourceUrls.length; i += POD_READ_CONCURRENCY) {
      const batch = await Promise.all(resourceUrls.slice(i, i + POD_READ_CONCURRENCY).map(readEvents));
      for (const found of batch) events.push(...found);
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

/**
 * Delete a calendar event from the Pod, throwing if it can't be deleted.
 * A resource that is already gone counts as deleted.
 * @param {string} eventUrl — Full Pod resource URL
 * @param {Function} fetch — Authenticated fetch
 */
export async function removeCalendarEventFromPod(eventUrl, fetch) {
  try {
    await deleteFile(eventUrl, { fetch });
  } catch (err) {
    const status = err?.response?.status ?? err?.statusCode;
    if (status === 404) return;
    throw err;
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
  updateBookingDetails,
  markConfirmationSent,
  saveCalendarEvent,
  loadCalendarEvents,
  deleteCalendarEventFromPod,
  removeCalendarEventFromPod,
};
