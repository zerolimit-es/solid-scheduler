import crypto from 'crypto';
import { validate, publicBookingSchema } from '../middleware/validate.js';
import { bookingLimiter, publicReadLimiter } from '../middleware/rateLimit.js';
import { Router } from 'express';
import { generateICS } from '../utils/ics.js';
import { safeMessage } from '../utils/errorResponse.js';
import { caldav, naiveToISO } from '../services/caldav.js';
import {
  initBookingsTable,
  createBooking,
  getBookingsBySlug,
  getBookingStats,
  getBookedSlots,
  cancelBooking,
  getBookingById,
  markPodCancelPending,
} from '../cloud/models/bookings-db.js';
import { syncCancellationsToPod } from '../cloud/services/pod-sync.js';
import { solidFetchMap } from '../middleware/auth.js';
import { getAvailability } from '../cloud/models/bookings-db.js';
import { getBlockedIntervals, isBlocked } from '../cloud/models/calendar-events-db.js';
import {
  sendVisitorConfirmation,
  sendOrganizerNotification,
} from '../cloud/services/email.js';
import { getTenantBySlug, getUsage, incrementUsage, getDb, getBranding } from '../cloud/models/database.js';
import { checkLimit } from '../cloud/config/tiers.js';
import { isValidTimeZone, instantToNaive, parseNaive } from '../utils/tz.js';
import {
  listActiveTeamMembers,
  getTeamMember,
  pickRoundRobinMember,
  incrementRoundRobinCount,
  getCollectiveSlots,
} from '../cloud/models/team-db.js';

const router = Router();

try {
  initBookingsTable();
  console.log('[Bookings] ✔ Bookings table ready');
} catch (e) {
  console.error('[Bookings] ✗ Failed to init bookings table:', e.message);
}

// ── Bookable slots ──────────────────────────────────────────────────────────
// One set of rules for both the slot list and the booking endpoint, so a
// time can be booked exactly when the page offers it.

const DEFAULT_TIMEZONE = 'Europe/Paris';
const DEFAULT_DURATION = 30;
const MIN_NOTICE_MINUTES = 15;
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "HH:MM" → minutes since midnight, or null if it isn't a time of day. */
function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && total <= 24 * 60 ? total : null;
}

function toTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function toDisplayTime(minutes) {
  const hour = Math.floor(minutes / 60) % 24;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minutes % 60).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

/** True for "YYYY-MM-DD" naming a real calendar day. */
function isRealDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !!parseNaive(`${date} 00:00`);
}

/** The booking page's meeting length and timezone, with safe fallbacks. */
function pageSettings(slug) {
  const avail = getAvailability(slug);
  const d = Number(avail?.eventDuration);
  return {
    avail,
    duration: Number.isInteger(d) && d >= 5 && d <= 480 ? d : DEFAULT_DURATION,
    tz: isValidTimeZone(avail?.timezone) ? avail.timezone : DEFAULT_TIMEZONE,
  };
}

/** What a page offers until its owner saves their hours: weekdays, 09:00–17:00. */
const DEFAULT_DAY = { start: '09:00', end: '17:00' };
const DEFAULT_WEEK = Object.fromEntries(DAY_NAMES.map((name) => [
  name, { enabled: name !== 'saturday' && name !== 'sunday', ...DEFAULT_DAY },
]));

/**
 * The page's settings for one weekday, as the public availability endpoint
 * reports them: the saved day, switched off if saved hours leave it out, or
 * the default week when nothing has been saved.
 */
function daySettings(avail, dayName) {
  if (!avail) return DEFAULT_WEEK[dayName];
  const saved = avail.days?.[dayName] || avail[dayName];
  return {
    enabled: !!saved?.enabled,
    start: saved?.start || DEFAULT_DAY.start,
    end: saved?.end || DEFAULT_DAY.end,
  };
}

/** Working hours for `date` in minutes, or null when the day is switched off. */
function dayWindow(avail, date) {
  const [y, m, d] = date.split('-').map(Number);
  const settings = daySettings(avail, DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]);
  if (!settings.enabled) return null;
  const start = toMinutes(settings.start) ?? 9 * 60;
  // A booking must end the same day (bookings are stored per day)
  const end = Math.min(toMinutes(settings.end) ?? 17 * 60, 24 * 60 - 1);
  return end > start ? { start, end } : null;
}

/**
 * Start times (minutes since midnight) offered on `date`: every `duration`
 * minutes within working hours, or the team's common slots in collective
 * mode. Nothing on past days; today only from MIN_NOTICE_MINUTES ahead.
 */
function slotStarts(organizer, slug, date, { avail, duration, tz }) {
  const now = instantToNaive(new Date(), tz);
  const today = now.slice(0, 10);
  if (date < today) return [];
  const earliest = date === today ? toMinutes(now.slice(11)) + MIN_NOTICE_MINUTES : -1;

  let starts = [];
  if (organizer?.scheduling_mode === 'collective') {
    starts = getCollectiveSlots(organizer.id, date, slug, duration).map((s) => toMinutes(s.time));
  } else {
    const hours = dayWindow(avail, date);
    if (hours) {
      for (let m = hours.start; m + duration <= hours.end; m += duration) starts.push(m);
    }
  }
  return starts.filter((m) => m !== null && m > earliest);
}

/** Existing bookings on `date` as minute ranges. */
function bookedIntervals(slug, date) {
  return getBookedSlots(slug, date).map((b) => {
    const startMin = toMinutes(String(b.start_time).slice(11));
    if (startMin === null) return null;
    const sameDay = String(b.end_time).slice(0, 10) === date;
    const endMin = sameDay ? toMinutes(String(b.end_time).slice(11)) : 24 * 60;
    return { startMin, endMin: endMin !== null && endMin > startMin ? endMin : startMin + DEFAULT_DURATION };
  }).filter(Boolean);
}

// GET /api/public/:slug - booking page info
router.get('/:slug', publicReadLimiter, (req, res) => {
  const { slug } = req.params;
  if (['register', 'resolve', 'bookings'].includes(slug)) return res.status(404).json({ error: 'Not found' });
  const stats = getBookingStats(slug);
  const avail = getAvailability(slug);
  res.json({ slug, profile: { name: avail?.name || process.env.ORGANIZER_NAME || 'SolidScheduler', eventDuration: avail?.eventDuration || 30, timezone: avail?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone }, stats });
});

// GET /api/public/:slug/team - public team info for booking page
router.get('/:slug/team', publicReadLimiter, (req, res) => {
  const { slug } = req.params;
  const organizer = getTenantBySlug(slug);
  if (!organizer || (organizer.scheduling_mode || 'none') === 'none') {
    return res.json({ teamScheduling: false, members: [], schedulingMode: 'none' });
  }
  const members = listActiveTeamMembers(organizer.id).map(m => ({
    id: m.id,
    name: m.name,
  }));
  res.json({
    teamScheduling: true,
    schedulingMode: organizer.scheduling_mode,
    members,
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

    const organizer = getTenantBySlug(slug);
    const settings = pageSettings(slug);
    const { duration } = settings;
    const booked = bookedIntervals(slug, date);
    const calBlocked = organizer?.id ? getBlockedIntervals(organizer.id, date) : [];

    // A slot is taken when any booking or blocked time overlaps it
    const slots = slotStarts(organizer, slug, date, settings).map((m) => ({
      time: toTime(m),
      displayTime: toDisplayTime(m),
      isBooked: isBlocked(booked, m, m + duration) || isBlocked(calBlocked, m, m + duration),
    }));
    res.json({ date, duration, slots, count: slots.filter(s => !s.isBooked).length });
  } catch (error) {
    console.error('Get slots error:', error);
    res.status(500).json({ error: 'Failed to get slots', message: safeMessage(error) });
  }
});

// POST /api/public/:slug/book - create a booking
router.post('/:slug/book', bookingLimiter, validate(publicBookingSchema), async (req, res) => {
  try {
    const { slug } = req.params;
    const { date, time, name, email, notes, teamMemberId } = req.body;

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

    if (organizer) {
      const currentUsage = getUsage(organizer.id, 'bookingsPerMonth');
      const check = checkLimit(organizer.tier, 'bookingsPerMonth', currentUsage);
      if (!check.allowed) {
        return res.status(429).json({
          error: 'limit_reached',
          message: `This booking page has reached its monthly limit. Please try again next month or contact the organizer.`,
          limit: check.limit,
          current: check.current,
        });
      }
    }

    // --- Team assignment logic ---
    let assignedMember = null;
    const schedulingMode = organizer?.scheduling_mode || 'none';

    if (schedulingMode !== 'none' && organizer) {
      if (schedulingMode === 'round_robin') {
        assignedMember = pickRoundRobinMember(organizer.id);
        if (!assignedMember) {
          return res.status(503).json({ error: 'No team members available for this booking' });
        }
      } else if (schedulingMode === 'managed') {
        if (!teamMemberId) {
          return res.status(400).json({ error: 'teamMemberId is required for managed scheduling' });
        }
        const member = getTeamMember(teamMemberId);
        if (!member || member.tenant_id !== organizer.id || !member.active) {
          return res.status(400).json({ error: 'Invalid or inactive team member' });
        }
        assignedMember = member;
      }
      // collective mode: all members attend, no single assignment
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
    if (startMin === null || !slotStarts(organizer, slug, date, settings).includes(startMin)) {
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
    const startICS = `${year}${month.toString().padStart(2,'0')}${day.toString().padStart(2,'0')}T${hour.toString().padStart(2,'0')}${minute.toString().padStart(2,'0')}00`;
    const endICS = `${year}${month.toString().padStart(2,'0')}${day.toString().padStart(2,'0')}T${endH.toString().padStart(2,'0')}${endM.toString().padStart(2,'0')}00`;
    const nowICS = fmtNowUTC();

    const icsContent = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SolidScheduler//Privacy-First Scheduling//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${bookingId}@solidscheduler.local`,
      `DTSTAMP:${nowICS}`,
      `DTSTART;TZID=${tz}:${startICS}`,
      `DTEND;TZID=${tz}:${endICS}`,
      `SUMMARY:Meeting - ${esc(name)} & ${esc(process.env.ORGANIZER_NAME || 'Organizer')}`,
      `DESCRIPTION:Booking via SolidScheduler\\n\\nAttendee: ${esc(name)}\\nEmail: ${esc(email)}${notes ? '\\nNotes: ' + esc(notes) : ''}`,
      'LOCATION:Video Call',
      `ORGANIZER;CN=${esc(process.env.ORGANIZER_NAME || 'Organizer')}:mailto:${process.env.SMTP_FROM || 'noreply@solidscheduler.local'}`,
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
      title: `Meeting - ${name} & ${assignedMember ? esc(assignedMember.name) : (process.env.ORGANIZER_NAME || 'Organizer')}`,
      start: key,
      end: `${date} ${endTime}`,
      attendeeName: name,
      attendeeEmail: email,
      notes: notes || '',
      icsContent,
      assignedMemberId: assignedMember?.id || null,
      assignedMemberName: assignedMember?.name || null,
      assignedMemberEmail: assignedMember?.email || null,
    };

    const bookAndCount = getDb().transaction((payload, organizerId, member, mode) => {
      createBooking(payload);
      if (organizerId) {
        incrementUsage(organizerId, 'bookingsPerMonth');
      }
      if (mode === 'round_robin' && member) {
        incrementRoundRobinCount(member.id);
      }
    });

    bookAndCount(bookingPayload, organizer?.id, assignedMember, schedulingMode);

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
      assignedMember: assignedMember ? { id: assignedMember.id, name: assignedMember.name, email: assignedMember.email } : null,
      notes: notes || '',
      location: 'Video Call',
    };

    // Get organizer email from availability settings (bookingAvail fetched above for ICS timezone)
    const orgEmail = bookingAvail?.email || bookingAvail?.organizerEmail || organizer?.email;

    // Send branded emails (non-blocking)
    const tenantBranding = organizer?.id ? getBranding(organizer.id) : null;
    Promise.all([
      sendVisitorConfirmation({ booking: bookingData, icsContent, branding: tenantBranding }).catch(err => {
        console.error('[Email] ✗ Visitor email failed:', err.message);
      }),
      sendOrganizerNotification({ booking: bookingData, icsContent, organizerEmail: orgEmail, branding: tenantBranding }).catch(err => {
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

// GET /api/public/:slug/bookings
// Public endpoint: only expose busy time ranges, never attendee PII
// (names, emails, notes, ICS content stay private to the organizer).
router.get('/:slug/bookings', publicReadLimiter, (req, res) => {
  try {
    const { slug } = req.params;
    const bookings = getBookingsBySlug(slug, { limit: 20, upcoming: true })
      .map(b => ({ start: b.start_time, end: b.end_time }));
    const stats = getBookingStats(slug);
    res.json({ bookings, stats });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get bookings', message: safeMessage(error) });
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
    // Check organizer's tier allows cancellation
    const tenant = getTenantBySlug(req.params.slug);
    if (tenant) {
      const result = checkLimit(tenant.tier, 'cancelBooking');
      if (!result.allowed) {
        return res.status(403).json({
          error: 'upgrade_required',
          message: 'Booking cancellation requires a Pro plan or higher.',
          feature: 'cancelBooking',
        });
      }
    }
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

function esc(t) {
  if (!t) return '';
  return t.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

export default router;
