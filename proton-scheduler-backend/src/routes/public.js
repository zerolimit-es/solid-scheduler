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
} from '../cloud/models/bookings-db.js';
import { getAvailability } from '../cloud/models/bookings-db.js';
import { getBlockedIntervals, isBlocked } from '../cloud/models/calendar-events-db.js';
import {
  sendVisitorConfirmation,
  sendOrganizerNotification,
} from '../cloud/services/email.js';
import { getTenantBySlug, getUsage, incrementUsage, getDb, getBranding } from '../cloud/models/database.js';
import { checkLimit } from '../cloud/config/tiers.js';
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
    const avail = getAvailability(req.params.slug);
    if (!avail) {
      return res.json({
        eventDuration: 30,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        monday: { enabled: true, start: '09:00', end: '17:00' },
        tuesday: { enabled: true, start: '09:00', end: '17:00' },
        wednesday: { enabled: true, start: '09:00', end: '17:00' },
        thursday: { enabled: true, start: '09:00', end: '17:00' },
        friday: { enabled: true, start: '09:00', end: '17:00' },
        saturday: { enabled: false, start: '09:00', end: '17:00' },
        sunday: { enabled: false, start: '09:00', end: '17:00' },
      });
    }
    const result = { ...avail };
    if (result.days) {
      for (const [day, settings] of Object.entries(result.days)) {
        result[day] = {
          enabled: settings.enabled || false,
          start: settings.start || '09:00',
          end: settings.end || '17:00',
        };
      }
    }
    for (const d of ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']) {
      if (!result[d]) result[d] = { enabled: false, start: '09:00', end: '17:00' };
    }
    res.json({
      eventDuration: result.eventDuration || 30,
      timezone: result.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      monday: result.monday,
      tuesday: result.tuesday,
      wednesday: result.wednesday,
      thursday: result.thursday,
      friday: result.friday,
      saturday: result.saturday,
      sunday: result.sunday,
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

    // Collective mode: return intersected slots from all team members
    const slotOrganizer = getTenantBySlug(slug);
    if (slotOrganizer && slotOrganizer.scheduling_mode === 'collective') {
      const avail = getAvailability(slug);
      const duration = avail?.eventDuration || 30;
      const collectiveSlots = getCollectiveSlots(slotOrganizer.id, date, slug, duration);
      const booked = getBookedSlots(slug, date);
      const calBlocked = getBlockedIntervals(slotOrganizer.id, date);
      const bookedTimes = new Set(booked.map(b => b.start_time));
      const filtered = collectiveSlots.map(s => {
        const [h, m] = s.time.split(':').map(Number);
        const startMin = h * 60 + m;
        return {
          ...s,
          isBooked: bookedTimes.has(`${date} ${s.time}`) || isBlocked(calBlocked, startMin, startMin + duration),
        };
      });
      return res.json({ date, slots: filtered, count: filtered.filter(s => !s.isBooked).length });
    }

    const [year, month, day] = date.split('-').map(Number);
    const dateObj = new Date(year, month - 1, day);
    const dayOfWeek = dateObj.getDay();
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayName = dayNames[dayOfWeek];

    const avail = getAvailability(slug);
    let daySettings = null;
    if (avail) {
      if (avail.days && avail.days[dayName]) daySettings = avail.days[dayName];
      else if (avail[dayName]) daySettings = avail[dayName];
    }
    if (daySettings && !daySettings.enabled) {
      return res.json({ date, slots: [], count: 0 });
    }

    const startTime = daySettings?.start || '09:00';
    const endTime = daySettings?.end || '17:00';
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    const slotStart = startH * 60 + startM;
    const slotEnd = endH * 60 + endM;

    const tz = avail?.timezone || 'Europe/Paris';
    const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    const todayStr = nowInTz.getFullYear() + '-' + String(nowInTz.getMonth()+1).padStart(2,'0') + '-' + String(nowInTz.getDate()).padStart(2,'0');
    const isToday = date === todayStr;
    const nowMin = isToday ? nowInTz.getHours() * 60 + nowInTz.getMinutes() : 0;

    const booked = getBookedSlots(slug, date);
    const organizer = getTenantBySlug(slug);
    const calBlocked = organizer?.id ? getBlockedIntervals(organizer.id, date) : [];
    const bookedTimes = new Set(booked.map(b => b.start_time));
    const slots = [];
    for (let m = slotStart; m < slotEnd; m += 30) {
      if (isToday && m <= nowMin + 15) continue;
      const hour = Math.floor(m / 60);
      const min = m % 60;
      const time = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
      const key = `${date} ${time}`;
      // Public bookings are 30 minutes long; block any slot an event overlaps
      const isBooked = bookedTimes.has(key) || isBlocked(calBlocked, m, m + 30);
      const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const displayTime = `${h12}:${min.toString().padStart(2, '0')} ${ampm}`;
      slots.push({ time, displayTime, isBooked });
    }
    res.json({ date, slots, count: slots.filter(s => !s.isBooked).length });
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

    // Check conflicts
    const existing = getBookedSlots(slug, date);
    const key = `${date} ${time}`;
    if (existing.some(b => b.start_time === key)) {
      return res.status(409).json({ error: 'Time slot already booked' });
    }
    // Refuse times the organizer has blocked in their calendar (the slot list
    // hides them, but a client could still post one directly)
    if (organizer?.id) {
      const [bh, bm] = time.split(':').map(Number);
      if (isBlocked(getBlockedIntervals(organizer.id, date), bh * 60 + bm, bh * 60 + bm + 30)) {
        return res.status(409).json({ error: 'Time slot unavailable' });
      }
    }

    // Calculate times
    const [hour, minute] = time.split(':').map(Number);
    const endMinTotal = hour * 60 + minute + 30;
    const endH = Math.floor(endMinTotal / 60);
    const endM = endMinTotal % 60;
    const endTime = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;

    // Cryptographically random ID — it doubles as the cancellation/ICS
    // capability token, so it must not be guessable.
    const bookingId = `booking-${crypto.randomUUID()}`;
    const [year, month, day] = date.split('-').map(Number);

    // ICS — use TZID so Proton Mail doesn't warn "Floating times not supported"
    const bookingAvail = getAvailability(slug);
    const tz = bookingAvail?.timezone || 'Europe/Paris';
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
    const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const endH12 = endH > 12 ? endH - 12 : endH === 0 ? 12 : endH;
    const endAmpm = endH >= 12 ? 'PM' : 'AM';
    const startDisplay = `${h12}:${minute.toString().padStart(2,'0')} ${ampm}`;
    const endDisplay = `${endH12}:${endM.toString().padStart(2,'0')} ${endAmpm}`;

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
