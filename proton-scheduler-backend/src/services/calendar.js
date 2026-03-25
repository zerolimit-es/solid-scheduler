/**
 * Calendar Service
 * 
 * Handles scheduling logic:
 * - Generating available time slots
 * - Checking availability
 * - Managing bookings with conflict detection
 * - Recurring events support
 */

import solidService from './solid.js';
import emailService from './email.js';
import { generateICS, generateRecurringICS, generateOccurrenceCancellationICS } from '../utils/ics.js';
import { 
  generateOccurrences, 
  expandRecurringEvent, 
  describeRecurrence,
  buildRRule,
  RECURRENCE_PRESETS 
} from '../utils/recurrence.js';
import { SCHEMA } from '../utils/rdf.js';

/**
 * Day name to JavaScript Date.getDay() index
 */
const dayNameToIndex = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const indexToDayName = Object.fromEntries(
  Object.entries(dayNameToIndex).map(([k, v]) => [v, k])
);

/**
 * Generate available time slots for a given date range
 * @param {Object} availability - User's availability settings
 * @param {Array} existingBookings - Existing bookings to exclude (including recurring)
 * @param {Object} options - Options for slot generation
 * @returns {Array} Array of available slots
 */
export function generateAvailableSlots(availability, existingBookings = [], options = {}) {
  const {
    startDate = new Date(),
    endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days default
    timezone = availability.timezone || 'UTC',
  } = options;
  
  const slots = [];
  const duration = availability.eventDuration || 30; // minutes
  const bufferBefore = availability.bufferBefore || 0;
  const bufferAfter = availability.bufferAfter || 0;
  const minNotice = availability.minNotice || 0; // hours
  
  // Minimum time for booking (now + minNotice hours)
  const minBookingTime = new Date(Date.now() + minNotice * 60 * 60 * 1000);
  
  // Expand recurring bookings into individual occurrences
  const expandedBookings = [];
  for (const booking of existingBookings) {
    if (booking.status === SCHEMA.EventCancelled) continue;
    
    if (booking.isRecurring && booking.recurrence) {
      // Expand recurring event
      const occurrences = expandRecurringEvent(booking, {
        rangeStart: startDate,
        rangeEnd: endDate,
        maxOccurrences: 100,
      });
      expandedBookings.push(...occurrences);
    } else {
      expandedBookings.push(booking);
    }
  }
  
  // Create a set of booked time ranges for quick lookup
  const bookedRanges = expandedBookings
    .filter(b => b.status !== SCHEMA.EventCancelled)
    .map(b => ({
      start: new Date(b.start).getTime() - bufferBefore * 60 * 1000,
      end: new Date(b.end).getTime() + bufferAfter * 60 * 1000,
    }));
  
  // Iterate through each day in the range
  const currentDate = new Date(startDate);
  currentDate.setHours(0, 0, 0, 0);
  
  while (currentDate < endDate) {
    const dayIndex = currentDate.getDay();
    const dayName = indexToDayName[dayIndex];
    const dayAvailability = availability.days?.[dayName];
    
    if (dayAvailability?.enabled) {
      // Parse start and end times
      const [startHour, startMin] = dayAvailability.start.split(':').map(Number);
      const [endHour, endMin] = dayAvailability.end.split(':').map(Number);
      
      const dayStart = new Date(currentDate);
      dayStart.setHours(startHour, startMin, 0, 0);
      
      const dayEnd = new Date(currentDate);
      dayEnd.setHours(endHour, endMin, 0, 0);
      
      // Generate slots for this day
      let slotStart = new Date(dayStart);
      
      while (slotStart < dayEnd) {
        const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
        
        // Check if slot is valid
        if (slotEnd <= dayEnd && slotStart >= minBookingTime) {
          const slotStartTime = slotStart.getTime();
          const slotEndTime = slotEnd.getTime();
          
          // Check for conflicts with existing bookings (including expanded recurring)
          const hasConflict = bookedRanges.some(range => 
            slotStartTime < range.end && slotEndTime > range.start
          );
          
          if (!hasConflict) {
            slots.push({
              start: new Date(slotStart),
              end: new Date(slotEnd),
              date: currentDate.toISOString().split('T')[0],
              time: slotStart.toTimeString().slice(0, 5),
              displayTime: slotStart.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
              }),
            });
          }
        }
        
        // Move to next slot
        slotStart = new Date(slotStart.getTime() + duration * 60 * 1000);
      }
    }
    
    // Move to next day
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  // Sort by start time to ensure consistent ordering
  slots.sort((a, b) => a.start - b.start);

  return slots;
}

/**
 * Get available slots for a specific date
 * @param {string} podUrl - User's Pod URL
 * @param {string} date - Date string (YYYY-MM-DD)
 * @param {Function} fetch - Authenticated fetch
 * @returns {Array} Available slots for the date
 */
export async function getAvailableSlotsForDate(podUrl, date, fetch) {
  const availability = await solidService.loadAvailability(podUrl, fetch);
  if (!availability) {
    throw new Error('Availability settings not found');
  }
  
  const bookings = await solidService.loadBookings(podUrl, fetch, {
    from: new Date(date),
    to: new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000),
  });
  
  const targetDate = new Date(date);
  const nextDate = new Date(targetDate.getTime() + 24 * 60 * 60 * 1000);
  
  const slots = generateAvailableSlots(availability, bookings, {
    startDate: targetDate,
    endDate: nextDate,
  });
  
  return slots;
}

/**
 * Get available dates in a month (dates that have at least one slot)
 * @param {string} podUrl - User's Pod URL
 * @param {number} year - Year
 * @param {number} month - Month (1-12)
 * @param {Function} fetch - Authenticated fetch
 * @returns {Array} Array of date strings with availability
 */
export async function getAvailableDatesInMonth(podUrl, year, month, fetch) {
  const availability = await solidService.loadAvailability(podUrl, fetch);
  if (!availability) {
    return [];
  }
  
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59);
  
  const bookings = await solidService.loadBookings(podUrl, fetch, {
    from: startDate,
    to: endDate,
  });
  
  const slots = generateAvailableSlots(availability, bookings, {
    startDate,
    endDate,
  });
  
  // Group by date
  const dateSet = new Set(slots.map(s => s.date));
  return Array.from(dateSet).sort();
}

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
  const hasConflict = await solidService.checkSlotConflict(podUrl, start, end, fetch);
  if (hasConflict) {
    throw new Error('This time slot is no longer available');
  }
  
  // Create booking object
  const bookingId = `booking-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
      
      // Update booking with confirmation status
      await solidService.saveBooking(podUrl, { ...booking, confirmationSent: true }, fetch);
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError.message);
      // Don't fail the booking if email fails
    }
  }
  
  // Generate ICS content (includes RRULE for recurring events)
  booking.timezone = availability.timezone || null;
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
export async function getExpandedBookings(podUrl, fetch, rangeStart, rangeEnd) {
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
    // Non-recurring: just update normally
    const updatedBooking = { ...booking, ...updates };
    await solidService.saveBooking(podUrl, updatedBooking, fetch);
    return updatedBooking;
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
 * Get upcoming bookings for a user
 * @param {string} podUrl - User's Pod URL
 * @param {Function} fetch - Authenticated fetch
 * @param {number} limit - Maximum number of bookings to return
 */
export async function getUpcomingBookings(podUrl, fetch, limit = 10) {
  const now = new Date();
  const bookings = await solidService.loadBookings(podUrl, fetch, {
    from: now,
  });
  
  return bookings
    .filter(b => b.status !== SCHEMA.EventCancelled)
    .slice(0, limit);
}

/**
 * Get booking statistics
 * @param {string} podUrl - User's Pod URL
 * @param {Function} fetch - Authenticated fetch
 */
export async function getBookingStats(podUrl, fetch) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  
  const allBookings = await solidService.loadBookings(podUrl, fetch);
  const activeBookings = allBookings.filter(b => b.status !== SCHEMA.EventCancelled);
  
  return {
    total: activeBookings.length,
    thisWeek: activeBookings.filter(b => new Date(b.createdAt) >= weekAgo).length,
    thisMonth: activeBookings.filter(b => new Date(b.createdAt) >= monthAgo).length,
    upcoming: activeBookings.filter(b => new Date(b.start) >= now).length,
    cancelled: allBookings.filter(b => b.status === SCHEMA.EventCancelled).length,
  };
}

export default {
  generateAvailableSlots,
  getAvailableSlotsForDate,
  getAvailableDatesInMonth,
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
