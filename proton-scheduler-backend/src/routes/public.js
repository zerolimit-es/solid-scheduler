import { validate, publicBookingSchema } from '../middleware/validate.js';
import { bookingLimiter, publicReadLimiter } from '../middleware/rateLimit.js';
import { Router } from 'express';
import { generateICS } from '../utils/ics.js';
import { safeMessage } from '../utils/errorResponse.js';
import {
  initBookingsTable,
  createBooking,
  getBookingsBySlug,
  getAllUpcomingBookings,
  getBookingStats,
  getBookedSlots,
  cancelBooking,
  getBookingById,
} from '../cloud/models/bookings-db.js';
import { getAvailability } from '../cloud/models/bookings-db.js';
import { getBlockedSlots as getCalendarBlockedSlots } from '../cloud/models/calendar-events-db.js';
import {
  sendVisitorConfirmation,
  sendOrganizerNotification,
} from '../cloud/services/email.js';
// Phase 2 change: import getTenantBySlug (direct index lookup) instead of
// getTenantByEmail (fragile email-indirection via availability record).
// getTenantByEmail kept as fallback for tenants who haven't set booking_slug yet.
import { getTenantBySlug, getTenantByEmail, getUsage, incrementUsage, getDb, getBranding } from '../cloud/models/database.js';
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
router.get('/:slug', (req, res) => {
  const { slug } = req.params;
  if (['register', 'resolve', 'bookings'].includes(slug)) return res.status(404).json({ error: 'Not found' });
  const stats = getBookingStats(slug);
  const avail = getAvailability(slug);
  res.json({ slug, profile: { name: avail?.name || process.env.ORGANIZER_NAME || 'ProtonScheduler', eventDuration: avail?.eventDuration || 30, timezone: avail?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone }, stats });
});

// GET /api/public/:slug/team - public team info for booking page
router.get('/:slug/team', (req, res) => {
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
router.get('/:slug/availability', (req, res) => {
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
router.get('/:slug/slots', (req, res) => {
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
      const calBlocked = slotOrganizer?.id ? getCalendarBlockedSlots(slotOrganizer.id, date) : [];
      const bookedTimes = new Set([
        ...booked.map(b => b.start_time),
        ...calBlocked.map(b => b.start_time),
      ]);
      const filtered = collectiveSlots.map(s => ({
        ...s,
        isBooked: bookedTimes.has(`${date} ${s.time}`),
      }));
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
    const calBlocked = organizer?.id ? getCalendarBlockedSlots(organizer.id, date) : [];
    const bookedTimes = new Set([
      ...booked.map(b => b.start_time),
      ...calBlocked.map(b => b.start_time),
    ]);
    const slots = [];
    for (let m = slotStart; m < slotEnd; m += 30) {
      if (isToday && m <= nowMin + 15) continue;
      const hour = Math.floor(m / 60);
      const min = m % 60;
      const time = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
      const key = `${date} ${time}`;
      const isBooked = bookedTimes.has(key);
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

    // -------------------------------------------------------------------------
    // Phase 2 fix (Task 12): Direct slug → tenant lookup
    //
    // BEFORE (fragile):
    //   const avail = getAvailability();
    //   const organizer = avail?.email || avail?.organizerEmail
    //     ? getTenantByEmail(avail.email || avail.organizerEmail) : null;
    //
    // This broke when availability.email ≠ tenant registration email.
    //
    // AFTER: Use the URL slug directly — it's already in req.params and
    // stored on the tenant row via booking_slug column (migration 001).
    // Falls back to the old email-based lookup for tenants who haven't
    // had their booking_slug populated yet (gradual migration).
    // -------------------------------------------------------------------------
    let organizer = getTenantBySlug(slug);

    if (!organizer) {
      // Fallback: old email-based lookup for pre-migration tenants
      const avail = getAvailability();
      const organizerEmail = avail?.email || avail?.organizerEmail;
      if (organizerEmail) {
        organizer = getTenantByEmail(organizerEmail);
      }
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

    // Calculate times
    const [hour, minute] = time.split(':').map(Number);
    const endMinTotal = hour * 60 + minute + 30;
    const endH = Math.floor(endMinTotal / 60);
    const endM = endMinTotal % 60;
    const endTime = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;

    const bookingId = `booking-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
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
      'PRODID:-//ProtonScheduler//Privacy-First Scheduling//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:REQUEST',
      'BEGIN:VEVENT',
      `UID:${bookingId}@protonscheduler.local`,
      `DTSTAMP:${nowICS}`,
      `DTSTART;TZID=${tz}:${startICS}`,
      `DTEND;TZID=${tz}:${endICS}`,
      `SUMMARY:Meeting - ${esc(name)} & ${esc(process.env.ORGANIZER_NAME || 'Organizer')}`,
      `DESCRIPTION:Booking via ProtonScheduler\\n\\nAttendee: ${esc(name)}\\nEmail: ${esc(email)}${notes ? '\\nNotes: ' + esc(notes) : ''}`,
      'LOCATION:Video Call',
      `ORGANIZER;CN=${esc(process.env.ORGANIZER_NAME || 'Organizer')}:mailto:${process.env.SMTP_FROM || 'noreply@protonscheduler.local'}`,
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
router.get('/:slug/bookings', (req, res) => {
  try {
    const { slug } = req.params;
    const bookings = getBookingsBySlug(slug, { limit: 20, upcoming: true });
    const stats = getBookingStats(slug);
    res.json({ bookings, stats });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get bookings', message: safeMessage(error) });
  }
});

// GET /api/public/bookings/all
router.get('/bookings/all', (req, res) => {
  try {
    const bookings = getAllUpcomingBookings({ limit: 20 });
    const stats = getBookingStats();
    res.json({ bookings, stats });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get bookings', message: safeMessage(error) });
  }
});

// GET /api/public/:slug/ics/:id
router.get('/:slug/ics/:id', (req, res) => {
  try {
    const booking = getBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="meeting-${req.params.id}.ics"`);
    res.send(booking.ics_content);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get ICS', message: safeMessage(error) });
  }
});

// DELETE /api/public/:slug/bookings/:id
router.delete('/:slug/bookings/:id', (req, res) => {
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
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    cancelBooking(req.params.id);
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
