/**
 * Calendar Service
 * 
 * Handles scheduling logic:
 * - Managing bookings with conflict detection
 * - Recurring events support
 */

import crypto from 'crypto';
import solidService from './solid.js';
import emailService from './email.js';
import { generateICS } from '../utils/ics.js';
import {
  expandRecurringEvent,
  describeRecurrence,
  RECURRENCE_PRESETS,
} from '../utils/recurrence.js';
import { SCHEMA } from '../utils/rdf.js';
import { currentPeriods, naiveToInstant } from '../utils/tz.js';

/**
 * Create a new booking
 * @param {Object} params - Booking parameters
 * @param {string} params.podUrl - Organizer's Pod URL
 * @param {Function} params.fetch - Authenticated fetch
 * @param {Date} params.start - Start time
 * @param {Date} params.end - End time
 * @param {Object} params.attendee - Attendee info {name, email}
 * @param {string} params.notes - Additional notes
 * @param {Object} [params.recurrence] - Recurrence rule (optional)
 * @param {Object} options - Additional options
 * @returns {Object} Created booking
 */
export async function createBooking(params, options = {}) {
  const { podUrl, fetch, start, end, attendee, notes, recurrence } = params;
  
  // Load organizer's availability for context
  const availability = await solidService.loadAvailability(podUrl, fetch);
  if (!availability) {
    throw new Error('Organizer availability not configured');
  }
  
  // Check for conflicts (for the first occurrence)
  // Recurring bookings repeat at the same local time in the account's timezone
  const hasConflict = await solidService.checkSlotConflict(podUrl, start, end, fetch, { timezone: availability.timezone });
  if (hasConflict) {
    throw new Error('This time slot is no longer available');
  }
  
  // Create booking object
  const bookingId = `booking-${crypto.randomUUID()}`;
  const seriesId = recurrence ? `series-${bookingId}` : null;
  
  const booking = {
    id: bookingId,
    seriesId,
    title: `Meeting with ${attendee.name}`,
    start: new Date(start),
    end: new Date(end),
    description: notes || '',
    location: options.location || 'Video Call',
    organizer: {
      name: availability.name,
      email: availability.email,
    },
    attendee: {
      name: attendee.name,
      email: attendee.email,
    },
    notes,
    status: SCHEMA.EventConfirmed,
    confirmationSent: false,
    // Recurrence fields
    isRecurring: !!recurrence,
    recurrence: recurrence || null,
    excludedDates: [],
  };
  
  // Save to Pod
  const bookingUrl = await solidService.saveBooking(podUrl, booking, fetch);
  booking.url = bookingUrl;
  // Emails and the invitation show times in the account's timezone
  booking.timezone = availability.timezone || null;
  
  // Send confirmation emails
  if (!options.skipEmail) {
    try {
      // Include recurrence info in email
      const emailBooking = { ...booking };
      if (booking.isRecurring) {
        emailBooking.recurrenceDescription = describeRecurrence(booking.recurrence);
      }
      
      await emailService.sendBookingConfirmation(emailBooking);
      booking.confirmationSent = true;
      
      // Record that the confirmation went out. (Saving the booking again
      // would not: an existing booking file is never overwritten.)
      await solidService.markConfirmationSent(bookingUrl, fetch)
        .catch((err) => console.warn('Could not record confirmation status:', err.message));
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError.message);
      // Don't fail the booking if email fails
    }
  }
  
  // Generate ICS content (includes RRULE for recurring events)
  booking.icsContent = generateICS({
    title: booking.title,
    start: booking.start,
    end: booking.end,
    description: booking.description,
    location: booking.location,
    organizer: booking.organizer,
    attendee: booking.attendee,
    uid: booking.id,
    recurrence: booking.recurrence,
    timezone: booking.timezone,
  });
  
  // Add recurrence description for API response
  if (booking.isRecurring) {
    booking.recurrenceDescription = describeRecurrence(booking.recurrence);
  }
  
  return booking;
}

/**
 * Cancel an existing booking
 * @param {string} podUrl - Organizer's Pod URL
 * @param {string} bookingId - Booking ID or URL
 * @param {Function} fetch - Authenticated fetch
 * @param {Object} options - Cancellation options
 * @param {string} [options.scope] - 'single' or 'all' for recurring events
 * @param {Date} [options.occurrenceDate] - Specific occurrence to cancel (for scope='single')
 */
export async function cancelBookingById(podUrl, bookingId, fetch, options = {}) {
  const bookings = await solidService.loadBookings(podUrl, fetch);
  const booking = bookings.find(b => b.id === bookingId || b.url === bookingId);
  
  if (!booking) {
    throw new Error('Booking not found');
  }
  
  // Handle recurring event cancellation
  if (booking.isRecurring && options.scope === 'single' && options.occurrenceDate) {
    // Cancel single occurrence by adding to excluded dates
    await solidService.addExcludedDate(booking.url, options.occurrenceDate, fetch);
    
    // Send cancellation for single occurrence
    if (!options.skipEmail) {
      try {
        await emailService.sendCancellationNotice({
          ...booking,
          start: options.occurrenceDate,
          end: new Date(options.occurrenceDate.getTime() + (booking.end - booking.start)),
        }, {
          reason: options.reason || 'This occurrence has been cancelled',
          cancelledBy: options.cancelledBy || 'the organizer',
          timezone: options.timezone,
        });
      } catch (emailError) {
        console.error('Failed to send cancellation email:', emailError.message);
      }
    }
    
    return { ...booking, cancelledOccurrence: options.occurrenceDate };
  }
  
  // Cancel entire booking/series
  await solidService.cancelBooking(booking.url, fetch);
  
  // Send cancellation emails
  if (!options.skipEmail) {
    try {
      await emailService.sendCancellationNotice(booking, {
        reason: options.reason,
        cancelledBy: options.cancelledBy || 'the organizer',
        timezone: options.timezone,
      });
    } catch (emailError) {
      console.error('Failed to send cancellation email:', emailError.message);
    }
  }
  
  return booking;
}

/**
 * Get expanded occurrences of recurring bookings within a date range
 * @param {string} podUrl - User's Pod URL
 * @param {Function} fetch - Authenticated fetch
 * @param {Date} rangeStart - Start of range
 * @param {Date} rangeEnd - End of range
 * @returns {Array} Expanded occurrences
 */
export async function getExpandedBookings(podUrl, fetch, rangeStart, rangeEnd, { timezone } = {}) {
  const bookings = await solidService.loadBookings(podUrl, fetch);
  const expanded = [];
  
  for (const booking of bookings) {
    if (booking.status === SCHEMA.EventCancelled) continue;
    
    if (booking.isRecurring && booking.recurrence) {
      // Expand recurring event
      const occurrences = expandRecurringEvent(booking, {
        rangeStart,
        rangeEnd,
        maxOccurrences: 100,
        timezone,
      });
      expanded.push(...occurrences);
    } else {
      // Non-recurring event
      if (booking.start >= rangeStart && booking.start <= rangeEnd) {
        expanded.push({
          ...booking,
          isRecurring: false,
          occurrenceDate: booking.start,
        });
      }
    }
  }
  
  // Sort by start date
  expanded.sort((a, b) => new Date(a.start) - new Date(b.start));
  
  return expanded;
}

/**
 * Update a recurring event series
 * @param {string} podUrl - Organizer's Pod URL
 * @param {string} bookingId - Booking ID
 * @param {Object} updates - Fields to update
 * @param {Function} fetch - Authenticated fetch
 * @param {Object} options - Update options
 * @param {string} [options.scope] - 'single' or 'all'
 * @param {Date} [options.occurrenceDate] - Specific occurrence (for scope='single')
 */
export async function updateRecurringBooking(podUrl, bookingId, updates, fetch, options = {}) {
  const bookings = await solidService.loadBookings(podUrl, fetch);
  const booking = bookings.find(b => b.id === bookingId || b.url === bookingId);
  
  if (!booking) {
    throw new Error('Booking not found');
  }
  
  if (!booking.isRecurring) {
    // A one-off booking: change its title, description and location in
    // place. (Saving it again would do nothing: an existing booking file is
    // never overwritten. And a one-off booking has no recurrence to change.)
    const { recurrence: _ignored, ...details } = updates;
    await solidService.updateBookingDetails(booking.url, details, fetch);
    return { ...booking, ...details };
  }
  
  if (options.scope === 'all') {
    // Update entire series
    await solidService.updateRecurringSeries(booking.url, updates, fetch);
    return { ...booking, ...updates };
  }
  
  // For single occurrence updates, we'd need to create an exception
  // This is more complex - for now, throw an error
  throw new Error('Single occurrence updates not yet supported. Cancel and recreate instead.');
}

/**
 * Get upcoming bookings for a user, soonest first.
 *
 * A recurring booking is listed once, at its next occurrence: `start` and
 * `end` are that occurrence, `seriesStart` is when the series began. A
 * series with no occurrence left is not upcoming.
 *
 * @param {string} podUrl - User's Pod URL
 * @param {Function} fetch - Authenticated fetch
 * @param {number} limit - Maximum number of bookings to return
 * @param {{ timezone?: string }} [options] - Timezone recurring bookings repeat in
 */
export async function getUpcomingBookings(podUrl, fetch, limit = 10, { timezone } = {}) {
  const now = new Date();
  const bookings = await solidService.loadBookings(podUrl, fetch, {
    from: now,
  });

  const upcoming = [];
  for (const booking of bookings) {
    if (booking.status === SCHEMA.EventCancelled) continue;

    if (!(booking.isRecurring && booking.recurrence)) {
      upcoming.push(booking);
      continue;
    }

    const [next] = expandRecurringEvent(booking, {
      rangeStart: now,
      rangeEnd: new Date(now.getTime() + 10 * 366 * 24 * 60 * 60 * 1000),
      maxOccurrences: 1,
      timezone,
    });
    if (!next) continue;
    // Keep the series' own ID: cancelling from the list acts on the series
    upcoming.push({ ...booking, start: next.start, end: next.end, seriesStart: booking.start });
  }

  return upcoming
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .slice(0, limit);
}

/**
 * Get booking statistics from the Pod.
 *
 * "This week" and "this month" count meetings that take place in the
 * current week and month in the account's timezone (every occurrence of a
 * recurring booking); "upcoming" counts bookings still to come (a series
 * once). The local statistics in bookings-db.js use the same definitions.
 *
 * @param {string} podUrl - User's Pod URL
 * @param {Function} fetch - Authenticated fetch
 * @param {{ timezone?: string }} [options]
 */
export async function getBookingStats(podUrl, fetch, { timezone = 'UTC' } = {}) {
  const periods = currentPeriods(timezone);
  const instant = (naive) => naiveToInstant(naive, timezone);
  const now = new Date();

  const allBookings = await solidService.loadBookings(podUrl, fetch, { includeCancelled: true });
  const active = allBookings.filter(b => b.status !== SCHEMA.EventCancelled);

  /** Meetings (occurrences) starting within [from, to). */
  const startingBetween = (from, to) => active.reduce((sum, booking) => {
    if (booking.isRecurring && booking.recurrence) {
      return sum + expandRecurringEvent(booking, { rangeStart: from, rangeEnd: to, maxOccurrences: 400, timezone })
        .filter(o => o.start < to).length;
    }
    return sum + (booking.start >= from && booking.start < to ? 1 : 0);
  }, 0);

  const upcoming = active.filter((booking) => {
    if (!(booking.isRecurring && booking.recurrence)) return booking.start >= now;
    return expandRecurringEvent(booking, {
      rangeStart: now,
      rangeEnd: new Date(now.getTime() + 10 * 366 * 24 * 60 * 60 * 1000),
      maxOccurrences: 1,
      timezone,
    }).length > 0;
  }).length;

  return {
    total: active.length,
    thisWeek: startingBetween(instant(periods.weekStart), instant(periods.weekEnd)),
    thisMonth: startingBetween(instant(periods.monthStart), instant(periods.monthEnd)),
    upcoming,
    cancelled: allBookings.length - active.length,
  };
}

export default {
  createBooking,
  cancelBookingById,
  getExpandedBookings,
  updateRecurringBooking,
  getUpcomingBookings,
  getBookingStats,
  // Re-export recurrence utilities for convenience
  RECURRENCE_PRESETS,
  describeRecurrence,
};
