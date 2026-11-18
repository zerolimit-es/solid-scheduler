import crypto from 'crypto';
import { validate, publicBookingSchema } from '../middleware/validate.js';
import { bookingLimiter, publicReadLimiter } from '../middleware/rateLimit.js';
import { Router } from 'express';
import { safeMessage } from '../utils/errorResponse.js';
import { caldav, naiveToISO } from '../services/caldav.js';
import {
  initBookingsTable,
  createBooking,
  cancelBooking,
  getBookingById,
  markPodCancelPending,
} from '../cloud/models/bookings-db.js';
import { syncCancellationsToPod } from '../cloud/services/pod-sync.js';
import { solidFetchMap } from '../middleware/auth.js';
import { getBlockedIntervals, isBlocked } from '../cloud/models/calendar-events-db.js';
import {
  sendVisitorConfirmation,
  sendOrganizerNotification,
} from '../cloud/services/email.js';
import { getTenantBySlug } from '../cloud/models/database.js';
import {
  toMinutes, toTime, toDisplayTime, isRealDate, pageSettings, daySettings,
  slotStarts, bookedIntervals, slotsFor,
} from '../services/slots.js';
import { instantToNaive } from '../utils/tz.js';
import { organizerIdentity } from '../utils/organizer.js';
import { confirmVerification } from '../cloud/models/email-verification-db.js';
import { buildVTimezone } from '../utils/vtimezone.js';
import { escapeICSText } from '../utils/ics.js';
import config from '../config/index.js';

const router = Router();

try {
  initBookingsTable();
  console.log('[Bookings] ✔ Bookings table ready');
} catch (e) {
  console.error('[Bookings] ✗ Failed to init bookings table:', e.message);
}

// POST /api/public/verify-email { token }
// Confirms an organizer's notification email. The token from the emailed
// link is the proof, so no sign-in is needed. A POST, sent by the "Confirm"
// button on the page the link opens: mail scanners that open links don't
// press it, so they can't confirm an address for anyone.
router.post('/verify-email', bookingLimiter, (req, res) => {
  const result = confirmVerification(req.body?.token);
  if (result.ok) return res.json({ confirmed: true });
  res.status(400).json({
    confirmed: false,
    reason: result.reason,
    error: result.reason === 'expired'
      ? 'This link has expired. Send a new one from your booking page settings.'
      : "This link isn't valid any more. Send a new one from your booking page settings.",
  });
});

// A booking page exists only for a slug an account holds. Every route below
// answers 404 for any other name, so a mistyped or retired link shows "not
// found" instead of a page that looks bookable and then refuses the booking.
router.param('slug', (req, res, next, slug) => {
  const organizer = typeof slug === 'string' ? getTenantBySlug(slug.toLowerCase()) : null;
  if (!organizer) {
    return res.status(404).json({ error: 'Booking page not found' });
  }
  req.organizer = organizer;
  next();
});

// GET /api/public/:slug - booking page info
router.get('/:slug', publicReadLimiter, (req, res) => {
  const { slug } = req.params;
  const { avail, duration, tz } = pageSettings(slug);
  res.json({
    slug,
    profile: {
      name: avail?.organizerName || avail?.name || config.organizer.name || 'SolidScheduler',
      eventDuration: duration,
      timezone: tz,
    },
  });
});

// GET /api/public/:slug/availability - public availability for calendar
router.get('/:slug/availability', publicReadLimiter, (req, res) => {
  try {
    const { avail, duration } = pageSettings(req.params.slug);
    res.json({
      eventDuration: duration,
      timezone: avail?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...Object.fromEntries(
        ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
          .map((name) => [name, daySettings(avail, name)])
      ),
    });
  } catch (err) {
    console.error('Public availability error:', err);
    res.status(500).json({ error: 'Failed to load availability' });
  }
});

// GET /api/public/:slug/slots - available slots for a date
router.get('/:slug/slots', publicReadLimiter, (req, res) => {
  try {
    const { slug } = req.params;
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Missing date parameter' });
    if (!isRealDate(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    res.json(slotsFor(slug, date, req.organizer?.id));
  } catch (error) {
    console.error('Get slots error:', error);
    res.status(500).json({ error: 'Failed to get slots', message: safeMessage(error) });
  }
});

// POST /api/public/:slug/book - create a booking
router.post('/:slug/book', bookingLimiter, validate(publicBookingSchema), async (req, res) => {
  try {
    const { slug } = req.params;
    const { date, time, name, email, notes } = req.body;

    if (!date || !time || !name || !email) {
      return res.status(400).json({ error: 'Missing required fields: date, time, name, email' });
    }

    const organizer = getTenantBySlug(slug);

    // A booking page exists only for a slug an account holds. Accepting
    // bookings for any other slug would park them under a name that a future
    // account could claim, and send mail on behalf of a page nobody owns.
    if (!organizer) {
      return res.status(404).json({ error: 'Booking page not found' });
    }

    // The time must be one the page offers: a real date, not in the past,
    // inside working hours and on the slot grid (the slot list only shows
    // these, but a client can post anything).
    if (!isRealDate(date)) {
      return res.status(400).json({ error: 'Validation failed', fields: { date: 'Date must be a real calendar date' } });
    }
    const settings = pageSettings(slug);
    const { duration, tz } = settings;
    const startMin = toMinutes(time);
    if (date < instantToNaive(new Date(), tz).slice(0, 10)) {
      return res.status(400).json({ error: 'This date is in the past' });
    }
    if (startMin === null || !slotStarts(date, settings).includes(startMin)) {
      return res.status(409).json({ error: 'Time slot unavailable' });
    }
    const endMinTotal = startMin + duration;

    // Refuse anything overlapping an existing booking, or time the organizer
    // has blocked in their calendar
    const key = `${date} ${time}`;
    if (isBlocked(bookedIntervals(slug, date), startMin, endMinTotal)) {
      return res.status(409).json({ error: 'Time slot already booked' });
    }
    if (isBlocked(getBlockedIntervals(organizer.id, date), startMin, endMinTotal)) {
      return res.status(409).json({ error: 'Time slot unavailable' });
    }

    // Calculate times
    const [hour, minute] = time.split(':').map(Number);
    const endH = Math.floor(endMinTotal / 60);
    const endM = endMinTotal % 60;
    const endTime = toTime(endMinTotal);

    // Cryptographically random ID — it doubles as the cancellation/ICS
    // capability token, so it must not be guessable.
    const bookingId = `booking-${crypto.randomUUID()}`;
    const [year, month, day] = date.split('-').map(Number);

    // ICS — use TZID so Proton Mail doesn't warn "Floating times not supported"
    const bookingAvail = settings.avail;
    // Who the meeting is with: the account's own name
    const host = organizerIdentity(bookingAvail);
    const meetingWith = host.name;
    const startICS = `${year}${month.toString().padStart(2,'0')}${day.toString().padStart(2,'0')}T${hour.toString().padStart(2,'0')}${minute.toString().padStart(2,'0')}00`;
    const endICS = `${year}${month.toString().padStart(2,'0')}${day.toString().padStart(2,'0')}T${endH.toString().padStart(2,'0')}${endM.toString().padStart(2,'0')}00`;
    const nowICS = fmtNowUTC();

    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SolidScheduler//Privacy-First Scheduling//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      // The file must define the timezone its times refer to
      ...buildVTimezone(tz),
      'BEGIN:VEVENT',
      `UID:${bookingId}@solidscheduler.local`,
      `DTSTAMP:${nowICS}`,
      `DTSTART;TZID=${tz}:${startICS}`,
      `DTEND;TZID=${tz}:${endICS}`,
      `SUMMARY:Meeting - ${esc(name)} & ${esc(meetingWith)}`,
      `DESCRIPTION:Booking via SolidScheduler\\n\\nAttendee: ${esc(name)}\\nEmail: ${esc(email)}${notes ? '\\nNotes: ' + esc(notes) : ''}`,
      'LOCATION:Video Call',
      `ORGANIZER;CN=${esc(host.name)}:mailto:${config.email.from}`,
      `ATTENDEE;CN=${esc(name)};RSVP=TRUE;PARTSTAT=ACCEPTED:mailto:${email}`,
      'STATUS:CONFIRMED',
      'SEQUENCE:0',
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      `DESCRIPTION:Meeting with ${esc(name)} in 15 minutes`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');

    // Display times
    const startDisplay = toDisplayTime(startMin);
    const endDisplay = toDisplayTime(endMinTotal);

    // Human-readable date
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dateObj = new Date(year, month - 1, day);
    const dateDisplay = `${days[dateObj.getDay()]}, ${months[month-1]} ${day}, ${year}`;

    // Phase 1 FIX: Atomic booking + usage increment
    const bookingPayload = {
      id: bookingId,
      slug,
      title: `Meeting - ${name} & ${meetingWith}`,
      organizerName: host.name,
      organizerEmail: host.email,
      start: key,
      end: `${date} ${endTime}`,
      attendeeName: name,
      attendeeEmail: email,
      notes: notes || '',
      icsContent,
    };

    createBooking(bookingPayload);

    // Copy to the operator's CalDAV calendar (background; only for CALDAV_BOOKING_SLUG)
    caldav().bookingCreated(slug, {
      id: bookingId,
      title: bookingPayload.title,
      start: naiveToISO(bookingPayload.start, tz),
      end: naiveToISO(bookingPayload.end, tz),
      attendeeName: name,
      attendeeEmail: email,
      notes,
      location: 'Video Call',
    });

    const bookingData = {
      id: bookingId,
      title: bookingPayload.title,
      date: dateDisplay,
      startTime: startDisplay,
      endTime: endDisplay,
      duration,
      attendee: { name, email },
      notes: notes || '',
      location: 'Video Call',
    };

    // Get organizer email from availability settings (bookingAvail fetched above for ICS timezone)
    const orgEmail = host.email;

    // Send emails (non-blocking)
    Promise.all([
      sendVisitorConfirmation({ booking: bookingData, icsContent }).catch(err => {
        console.error('[Email] ✗ Visitor email failed:', err.message);
      }),
      sendOrganizerNotification({ booking: bookingData, icsContent, organizerEmail: orgEmail }).catch(err => {
        console.error('[Email] ✗ Organizer email failed:', err.message);
      }),
    ]);

    res.status(201).json({
      success: true,
      booking: {
        ...bookingData,
        start: `${date}T${time}:00`,
        end: `${date}T${endTime}:00`,
      },
      icsContent,
    });
  } catch (error) {
    console.error('Booking error:', error);
    res.status(500).json({ error: 'Booking failed', message: safeMessage(error) });
  }
});

// GET /api/public/:slug/ics/:id
// The unguessable booking ID acts as the access token; the slug must match
// so a booking can't be fetched through another organizer's page.
router.get('/:slug/ics/:id', publicReadLimiter, (req, res) => {
  try {
    const booking = getBookingById(req.params.id);
    if (!booking || booking.slug !== req.params.slug) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    const safeId = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meeting-${safeId}.ics"`);
    res.send(booking.ics_content);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get ICS', message: safeMessage(error) });
  }
});

// DELETE /api/public/:slug/bookings/:id
// Rate-limited to slow down booking-ID guessing; the slug must match the
// booking so IDs can't be replayed across booking pages.
router.delete('/:slug/bookings/:id', bookingLimiter, (req, res) => {
  try {
    const tenant = req.organizer;
    const booking = getBookingById(req.params.id);
    if (!booking || booking.slug !== req.params.slug) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    cancelBooking(req.params.id);
    caldav().bookingCancelled(req.params.slug, req.params.id);

    // The booking may already be in the owner's Pod, where it would stay
    // confirmed. Cancel it there now if the owner is signed in; otherwise it
    // stays pending and is cancelled at their next sign-in.
    if (booking.synced_to_pod && booking.pod_url && booking.status !== 'cancelled') {
      markPodCancelPending(booking.id);
      const ownerFetch = tenant?.webid ? solidFetchMap.get(tenant.webid) : null;
      if (ownerFetch && tenant.solid_pod_url) {
        syncCancellationsToPod(tenant.solid_pod_url, ownerFetch, tenant.booking_slug)
          .catch((err) => console.warn('[Bookings] Pod cancellation deferred to next login:', err.message));
      }
    }
    res.json({ success: true, message: 'Booking cancelled' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to cancel booking', message: safeMessage(error) });
  }
});

// Helpers
function fmtNowUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}${(d.getUTCMonth()+1).toString().padStart(2,'0')}${d.getUTCDate().toString().padStart(2,'0')}T${d.getUTCHours().toString().padStart(2,'0')}${d.getUTCMinutes().toString().padStart(2,'0')}${d.getUTCSeconds().toString().padStart(2,'0')}Z`;
}

/** Escape text for an iCalendar property (also neutralises line breaks). */
const esc = escapeICSText;

export default router;
