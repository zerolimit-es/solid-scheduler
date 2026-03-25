/**
 * Bookings Routes
 *
 * Manage bookings stored in Solid Pods:
 * - GET /api/bookings - List bookings
 * - GET /api/bookings/expanded - List with recurring events expanded
 * - POST /api/bookings - Create a new booking (with optional recurrence)
 * - GET /api/bookings/:id - Get a specific booking
 * - PUT /api/bookings/:id - Update a booking/series
 * - DELETE /api/bookings/:id - Cancel a booking (single or series)
 * - GET /api/bookings/stats - Get booking statistics
 * - GET /api/bookings/presets - Get recurrence presets
 */

import { validate, createBookingSchema } from '../middleware/validate.js';
import { Router } from 'express';
import { requireAuth, getAuthenticatedFetch } from '../middleware/auth.js';
import { safeMessage } from '../utils/errorResponse.js';
import solidService from '../services/solid.js';
import calendarService from '../services/calendar.js';
import { generateICS } from '../utils/ics.js';
import { SCHEMA } from '../utils/rdf.js';
import { describeRecurrence, RECURRENCE_PRESETS } from '../utils/recurrence.js';
import { checkLimit } from '../cloud/config/tiers.js';
import { requireFeature } from '../cloud/middleware/tierEnforcement.js';
import { getUsage, incrementUsage, getDb } from '../cloud/models/database.js';
import {
  createBooking as createBookingInDb,
  getAllUpcomingBookings,
  getBookingsBySlug,
  getBookingStats as getLocalBookingStats,
  getBookingById,
  getAvailability,
} from '../cloud/models/bookings-db.js';
import { sendVisitorConfirmation, sendOrganizerNotification } from '../cloud/services/email.js';

const router = Router();

/**
 * GET /api/bookings/presets
 * Get available recurrence presets
 */
router.get('/presets', (req, res) => {
  const presets = [
    { id: 'none', label: 'Does not repeat', value: null },
    { id: 'daily', label: 'Daily', value: { frequency: 'DAILY' } },
    { id: 'weekdays', label: 'Every weekday (Mon-Fri)', value: { frequency: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] } },
    { id: 'weekly', label: 'Weekly', value: { frequency: 'WEEKLY' } },
    { id: 'biweekly', label: 'Every 2 weeks', value: { frequency: 'WEEKLY', interval: 2 } },
    { id: 'monthly', label: 'Monthly', value: { frequency: 'MONTHLY' } },
    { id: 'yearly', label: 'Yearly', value: { frequency: 'YEARLY' } },
  ];

  res.json({ presets });
});

/**
 * GET /api/bookings
 * List bookings for the authenticated user
 */
router.get('/', requireAuth(), async (req, res) => {
  try {
    const { from, to, status, pod } = req.query;

    let fetch;
    try {
      fetch = await getAuthenticatedFetch(req.solidSession);
    } catch {
      fetch = null;
    }

    if (fetch) {
      const pods = await solidService.getUserPods(req.user.webId, fetch);
      const podUrl = pod || pods[0];

      const options = {};
      if (from) options.from = new Date(from);
      if (to) options.to = new Date(to);
      if (status === 'confirmed') options.status = SCHEMA.EventConfirmed;
      if (status === 'cancelled') options.status = SCHEMA.EventCancelled;

      const bookings = await solidService.loadBookings(podUrl, fetch, options);

      const enrichedBookings = bookings.map(b => ({
        ...b,
        recurrenceDescription: b.isRecurring ? describeRecurrence(b.recurrence) : null,
      }));

      return res.json({
        bookings: enrichedBookings,
        count: enrichedBookings.length,
        podUrl,
      });
    }

    // Fallback: read from SQLite when Pod session is unavailable
    const slug = req.tenant?.booking_slug;
    const rows = slug
      ? getBookingsBySlug(slug, { limit: 50, upcoming: false })
      : getAllUpcomingBookings({ limit: 50 });

    const bookings = rows.map(r => ({
      id: r.id,
      title: r.title,
      start: r.start_time,
      end: r.end_time,
      attendee: { name: r.attendee_name, email: r.attendee_email },
      organizer: { name: r.organizer_name, email: r.organizer_email },
      status: r.status,
      location: r.location,
      notes: r.notes,
      syncedToPod: !!r.synced_to_pod,
    }));

    res.json({
      bookings,
      count: bookings.length,
      source: 'local',
    });
  } catch (error) {
    console.error('List bookings error:', error);
    res.status(500).json({
      error: 'Failed to load bookings',
      message: safeMessage(error),
    });
  }
});

/**
 * GET /api/bookings/expanded
 */
router.get('/expanded', requireAuth(), async (req, res) => {
  try {
    const { from, to, pod } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: 'Missing date range',
        message: 'from and to query parameters are required',
      });
    }

    const fetch = await getAuthenticatedFetch(req.solidSession);
    const pods = await solidService.getUserPods(req.user.webId, fetch);
    const podUrl = pod || pods[0];

    const expanded = await calendarService.getExpandedBookings(
      podUrl,
      fetch,
      new Date(from),
      new Date(to)
    );

    res.json({
      bookings: expanded,
      count: expanded.length,
      rangeStart: from,
      rangeEnd: to,
    });
  } catch (error) {
    console.error('Get expanded bookings error:', error);
    res.status(500).json({
      error: 'Failed to expand bookings',
      message: safeMessage(error),
    });
  }
});

/**
 * POST /api/bookings
 * Create a new booking — enforces bookingsPerMonth tier limit
 */
router.post('/', requireAuth(), async (req, res) => {
  try {
    // -------------------------------------------------------------------------
    // Tier enforcement: bookingsPerMonth
    // req.tenant is populated by loadTenant() in the cloud layer (integrate.js)
    // -------------------------------------------------------------------------
    if (req.tenant) {
      const currentUsage = getUsage(req.tenant.id, 'bookingsPerMonth');
      const check = checkLimit(req.tenant.tier, 'bookingsPerMonth', currentUsage);
      if (!check.allowed) {
        return res.status(429).json({
          error: 'limit_reached',
          message: `You've reached your ${req.tenant.tier} plan limit of ${check.limit} bookings per month.`,
          limit: check.limit,
          current: check.current,
          currentTier: req.tenant.tier,
          resetInfo: 'Limits reset at the start of each calendar month.',
        });
      }
    }

    let { start, end, attendee, notes, location, recurrence } = req.body;
    // Normalize frontend format: { date, time, name, email } -> { start, end, attendee }
    if (!start && req.body.date && req.body.time) {
      const duration = 30;
      const [h, m] = req.body.time.split(':').map(Number);
      start = `${req.body.date}T${req.body.time}:00`;
      const endH = h + Math.floor((m + duration) / 60);
      const endM = (m + duration) % 60;
      end = `${req.body.date}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`;
    }
    if (!attendee && req.body.name && req.body.email) {
      attendee = { name: req.body.name, email: req.body.email };
    }

    if (!start || !end || !attendee?.name || !attendee?.email) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'start, end, and attendee (with name and email) are required',
      });
    }

    if (recurrence) {
      const validFrequencies = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
      if (!validFrequencies.includes(recurrence.frequency?.toUpperCase())) {
        return res.status(400).json({
          error: 'Invalid recurrence',
          message: `frequency must be one of: ${validFrequencies.join(', ')}`,
        });
      }
      recurrence.frequency = recurrence.frequency.toUpperCase();
      if (recurrence.until && typeof recurrence.until === 'string') {
        recurrence.until = new Date(recurrence.until);
      }
    }

    // Build display strings the frontend ConfirmationView expects
    const startDt = new Date(start);
    const endDt = new Date(end);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const dateDisplay = `${days[startDt.getDay()]}, ${months[startDt.getMonth()]} ${startDt.getDate()}, ${startDt.getFullYear()}`;
    const fmt12 = (d) => {
      const h = d.getHours(), m = d.getMinutes();
      const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
      return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
    };
    const startTimeDisplay = fmt12(startDt);
    const endTimeDisplay = fmt12(endDt);

    // -----------------------------------------------------------------------
    // Try Pod-first, fall back to SQLite when Solid session is unavailable.
    // After a container restart the in-memory OIDC session is lost but the
    // cookie session persists, so requireAuth() passes yet Pod writes fail.
    // Saving to SQLite with synced_to_pod=0 keeps the booking safe — it
    // will be pushed to the Pod on the next successful sync.
    // -----------------------------------------------------------------------
    let fetch;
    try {
      fetch = await getAuthenticatedFetch(req.solidSession);
    } catch {
      // Solid session lost — fall back to SQLite below
      fetch = null;
    }

    if (fetch) {
      // ── Happy path: Solid session available → save to Pod ──
      const pods = await solidService.getUserPods(req.user.webId, fetch);
      const podUrl = req.query.pod || pods[0];

      const booking = await calendarService.createBooking(
        {
          podUrl,
          fetch,
          start: new Date(start),
          end: new Date(end),
          attendee,
          notes,
          recurrence,
        },
        { location }
      );

      if (req.tenant) {
        incrementUsage(req.tenant.id, 'bookingsPerMonth');
      }

      return res.status(201).json({
        success: true,
        message: booking.isRecurring ? 'Recurring booking created' : 'Booking created',
        booking: {
          id: booking.id,
          seriesId: booking.seriesId,
          title: booking.title,
          date: dateDisplay,
          startTime: startTimeDisplay,
          endTime: endTimeDisplay,
          start: booking.start,
          end: booking.end,
          organizer: booking.organizer,
          attendee: booking.attendee,
          confirmationSent: booking.confirmationSent,
          url: booking.url,
          location: booking.location || location || 'Video Call',
          notes: booking.notes || notes || '',
          isRecurring: booking.isRecurring,
          recurrence: booking.recurrence,
          recurrenceDescription: booking.recurrenceDescription,
        },
      });
    }

    // ── Fallback: Solid session lost → save to SQLite ──
    const bookingId = `booking-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
    const slug = req.tenant?.booking_slug || 'my-booking';
    const title = `Meeting with ${attendee.name}`;

    // Format times as "YYYY-MM-DD HH:MM" to match SQLite schema
    const fmt = (d) => {
      const yy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return `${yy}-${mm}-${dd} ${hh}:${mi}`;
    };

    const bookingPayload = {
      id: bookingId,
      slug,
      title,
      start: fmt(startDt),
      end: fmt(endDt),
      organizerName: process.env.ORGANIZER_NAME || '',
      organizerEmail: process.env.ORGANIZER_EMAIL || '',
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      notes: notes || '',
      location: location || 'Video Call',
    };

    const bookAndCount = getDb().transaction((payload, tenantId) => {
      createBookingInDb(payload);
      if (tenantId) {
        incrementUsage(tenantId, 'bookingsPerMonth');
      }
    });

    bookAndCount(bookingPayload, req.tenant?.id);

    console.log(`[Bookings] Saved to SQLite (Pod session lost): ${bookingId}`);

    // Generate ICS and send emails (non-blocking, same as public route)
    const bookingAvail = getAvailability(slug);
    const icsContent = generateICS({
      title,
      start: startDt,
      end: endDt,
      description: notes || '',
      location: location || 'Video Call',
      organizer: {
        name: process.env.ORGANIZER_NAME || 'Organizer',
        email: process.env.ORGANIZER_EMAIL || '',
      },
      attendee,
      uid: bookingId,
      timezone: bookingAvail?.timezone,
    });

    const bookingData = {
      title,
      date: dateDisplay,
      startTime: startTimeDisplay,
      endTime: endTimeDisplay,
      attendee,
      notes: notes || '',
      location: location || 'Video Call',
    };
    const orgEmail = bookingAvail?.email || bookingAvail?.organizerEmail
      || req.tenant?.email || process.env.ORGANIZER_EMAIL;

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
      message: 'Booking created',
      savedLocally: true,
      booking: {
        id: bookingId,
        title,
        date: dateDisplay,
        startTime: startTimeDisplay,
        endTime: endTimeDisplay,
        start: startDt.toISOString(),
        end: endDt.toISOString(),
        attendee,
        notes: notes || '',
        location: location || 'Video Call',
      },
      icsContent,
    });
  } catch (error) {
    console.error('Create booking error:', error);

    if (error.message.includes('no longer available')) {
      return res.status(409).json({
        error: 'Slot unavailable',
        message: safeMessage(error),
      });
    }

    res.status(500).json({
      error: 'Failed to create booking',
      message: safeMessage(error),
    });
  }
});

/**
 * GET /api/bookings/upcoming
 */
router.get('/upcoming', requireAuth(), async (req, res) => {
  try {
    const { limit = 10, pod } = req.query;

    let fetch;
    try {
      fetch = await getAuthenticatedFetch(req.solidSession);
    } catch {
      fetch = null;
    }

    if (fetch) {
      const pods = await solidService.getUserPods(req.user.webId, fetch);
      const podUrl = pod || pods[0];

      const bookings = await calendarService.getUpcomingBookings(
        podUrl,
        fetch,
        parseInt(limit)
      );

      const enrichedBookings = bookings.map(b => ({
        ...b,
        recurrenceDescription: b.isRecurring ? describeRecurrence(b.recurrence) : null,
      }));

      return res.json({
        bookings: enrichedBookings,
        count: enrichedBookings.length,
      });
    }

    // Fallback: read from SQLite
    const rows = getAllUpcomingBookings({ limit: parseInt(limit) });
    const bookings = rows.map(r => ({
      id: r.id,
      title: r.title,
      start: r.start_time,
      end: r.end_time,
      attendee: { name: r.attendee_name, email: r.attendee_email },
      status: r.status,
      location: r.location,
    }));

    res.json({
      bookings,
      count: bookings.length,
      source: 'local',
    });
  } catch (error) {
    console.error('Get upcoming bookings error:', error);
    res.status(500).json({
      error: 'Failed to get upcoming bookings',
      message: safeMessage(error),
    });
  }
});

/**
 * GET /api/bookings/stats
 */
router.get('/stats', requireAuth(), async (req, res) => {
  try {
    let fetch;
    try {
      fetch = await getAuthenticatedFetch(req.solidSession);
    } catch {
      fetch = null;
    }

    if (fetch) {
      const pods = await solidService.getUserPods(req.user.webId, fetch);
      const podUrl = req.query.pod || pods[0];
      const stats = await calendarService.getBookingStats(podUrl, fetch);
      return res.json(stats);
    }

    // Fallback: stats from SQLite
    const slug = req.tenant?.booking_slug || null;
    const stats = getLocalBookingStats(slug);
    res.json({ ...stats, source: 'local' });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      error: 'Failed to get booking statistics',
      message: safeMessage(error),
    });
  }
});

/**
 * GET /api/bookings/:id
 */
router.get('/:id', requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;

    let fetch;
    try {
      fetch = await getAuthenticatedFetch(req.solidSession);
    } catch {
      fetch = null;
    }

    if (fetch) {
      const pods = await solidService.getUserPods(req.user.webId, fetch);
      const podUrl = req.query.pod || pods[0];

      const bookings = await solidService.loadBookings(podUrl, fetch);
      const booking = bookings.find(b => b.id === id);

      if (!booking) {
        return res.status(404).json({
          error: 'Booking not found',
          message: `No booking found with ID: ${id}`,
        });
      }

      if (booking.isRecurring) {
        booking.recurrenceDescription = describeRecurrence(booking.recurrence);
      }

      return res.json({ booking });
    }

    // Fallback: look up in SQLite — verify booking belongs to this tenant
    const row = getBookingById(id);
    if (!row) {
      return res.status(404).json({
        error: 'Booking not found',
        message: `No booking found with ID: ${id}`,
      });
    }

    // Verify the booking belongs to the requesting user's tenant (by slug match)
    const tenantSlug = req.tenant?.booking_slug;
    if (tenantSlug && row.slug && row.slug !== tenantSlug) {
      return res.status(404).json({
        error: 'Booking not found',
        message: `No booking found with ID: ${id}`,
      });
    }

    res.json({
      booking: {
        id: row.id,
        title: row.title,
        start: row.start_time,
        end: row.end_time,
        attendee: { name: row.attendee_name, email: row.attendee_email },
        organizer: { name: row.organizer_name, email: row.organizer_email },
        status: row.status,
        location: row.location,
        notes: row.notes,
        syncedToPod: !!row.synced_to_pod,
      },
      source: 'local',
    });
  } catch (error) {
    console.error('Get booking error:', error);
    res.status(500).json({
      error: 'Failed to get booking',
      message: safeMessage(error),
    });
  }
});

/**
 * PUT /api/bookings/:id
 */
router.put('/:id', requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, location, recurrence, scope, occurrenceDate } = req.body;

    const fetch = await getAuthenticatedFetch(req.solidSession);
    const pods = await solidService.getUserPods(req.user.webId, fetch);
    const podUrl = req.query.pod || pods[0];

    const updates = {};
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (location !== undefined) updates.location = location;
    if (recurrence) updates.recurrence = recurrence;

    const updated = await calendarService.updateRecurringBooking(
      podUrl,
      id,
      updates,
      fetch,
      { scope, occurrenceDate: occurrenceDate ? new Date(occurrenceDate) : null }
    );

    res.json({
      success: true,
      message: 'Booking updated',
      booking: updated,
    });
  } catch (error) {
    console.error('Update booking error:', error);

    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: 'Booking not found',
        message: safeMessage(error),
      });
    }

    res.status(500).json({
      error: 'Failed to update booking',
      message: safeMessage(error),
    });
  }
});

/**
 * DELETE /api/bookings/:id
 */
router.delete('/:id', requireAuth(), requireFeature('cancelBooking'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, notify = true, scope = 'all', occurrenceDate } = req.body || {};

    const fetch = await getAuthenticatedFetch(req.solidSession);
    const pods = await solidService.getUserPods(req.user.webId, fetch);
    const podUrl = req.query.pod || pods[0];

    const booking = await calendarService.cancelBookingById(podUrl, id, fetch, {
      reason,
      skipEmail: !notify,
      cancelledBy: 'the organizer',
      scope,
      occurrenceDate: occurrenceDate ? new Date(occurrenceDate) : null,
    });

    const message = scope === 'single' && occurrenceDate
      ? 'Single occurrence cancelled'
      : booking.isRecurring
        ? 'Recurring booking series cancelled'
        : 'Booking cancelled';

    res.json({
      success: true,
      message,
      booking: {
        id: booking.id,
        title: booking.title,
        start: booking.start,
        end: booking.end,
        cancelledOccurrence: booking.cancelledOccurrence,
      },
    });
  } catch (error) {
    console.error('Cancel booking error:', error);

    if (error.message.includes('not found')) {
      return res.status(404).json({
        error: 'Booking not found',
        message: safeMessage(error),
      });
    }

    res.status(500).json({
      error: 'Failed to cancel booking',
      message: safeMessage(error),
    });
  }
});

/**
 * GET /api/bookings/:id/ics
 */
router.get('/:id/ics', requireAuth(), async (req, res) => {
  try {
    const { id } = req.params;
    const fetch = await getAuthenticatedFetch(req.solidSession);
    const pods = await solidService.getUserPods(req.user.webId, fetch);
    const podUrl = req.query.pod || pods[0];

    const bookings = await solidService.loadBookings(podUrl, fetch);
    const booking = bookings.find(b => b.id === id);

    if (!booking) {
      return res.status(404).json({
        error: 'Booking not found',
        message: `No booking found with ID: ${id}`,
      });
    }

    const icsContent = generateICS({
      title: booking.title,
      start: new Date(booking.start),
      end: new Date(booking.end),
      description: booking.description || booking.notes,
      location: booking.location,
      organizer: booking.organizer,
      attendee: booking.attendee,
      uid: booking.id,
      recurrence: booking.recurrence,
      excludedDates: booking.excludedDates,
    });

    const filename = `${booking.title.replace(/[^a-z0-9]/gi, '-')}.ics`;

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(icsContent);
  } catch (error) {
    console.error('Download ICS error:', error);
    res.status(500).json({
      error: 'Failed to generate ICS',
      message: safeMessage(error),
    });
  }
});

export default router;
