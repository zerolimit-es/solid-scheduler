/**
 * Request Validation Middleware
 *
 * Uses zod for schema validation on incoming requests.
 * Returns structured 400 errors with field-level messages.
 *
 * Install: npm install zod
 */

import { z } from 'zod';

// ── Generic Middleware Factory ────────────────────────────────────────────────

/**
 * Returns Express middleware that validates req.body against a zod schema.
 * On failure, responds with 400 + field-level error messages.
 *
 * Usage:
 *   router.post('/book', validate(publicBookingSchema), handler);
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.') || '_root';
        fields[path] = issue.message;
      }
      return res.status(400).json({
        error: 'Validation failed',
        fields,
      });
    }
    // Replace body with parsed (coerced/stripped) data
    req.body = result.data;
    next();
  };
}

// ── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Person name: no control characters (blocks header/log injection through
 * email display names and ICS fields).
 */
const nameField = z.string()
  .min(1, 'Name is required')
  .max(100, 'Name must be under 100 characters')
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f\x7f]+$/, 'Name contains invalid characters');

/** "YYYY-MM-DD" that names a real calendar day (rejects 2027-13-45, 2027-02-30). */
const dateField = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
  }, 'Date must be a real calendar date');

/** "HH:MM" on a 24-hour clock (rejects 24:00, 12:60). */
const timeField = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM');

const emailField = z.string().max(254).email('Invalid email address');
const notesField = z.string().max(1000, 'Notes must be under 1000 characters').optional().default('');

/** Recurrence rule. `until` and `count` are accepted from API clients. */
const recurrenceField = z.object({
  frequency: z.string().transform((v) => v.toUpperCase()).pipe(z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])),
  interval: z.number().int().positive().max(999).optional(),
  byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
  until: z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), 'until must be a date').optional(),
  count: z.number().int().positive().max(1000).optional(),
}).nullable().optional().default(null);

/** POST /api/public/:slug/book */
export const publicBookingSchema = z.object({
  date: dateField,
  time: timeField,
  name: nameField,
  email: emailField,
  notes: notesField,
  teamMemberId: z.string().max(100).optional(),
  recurrence: recurrenceField,
});

/** POST /api/bookings (authenticated), as the dashboard sends it */
export const createBookingSchema = z.object({
  date: dateField,
  time: timeField,
  name: nameField,
  email: emailField,
  notes: notesField,
  location: z.string().max(300).optional(),
  recurrence: recurrenceField,
});

/** An instant, e.g. "2030-09-16T07:30:00Z". */
const instantField = z.string().max(40).refine((v) => !Number.isNaN(Date.parse(v)), 'Must be a date and time');

/** POST /api/bookings (authenticated), as API clients send it: explicit start and end */
export const createBookingByInstantSchema = z.object({
  start: instantField,
  end: instantField,
  attendee: z.object({ name: nameField, email: emailField }),
  notes: notesField,
  location: z.string().max(300).optional(),
  recurrence: recurrenceField,
});

/** Validate POST /api/bookings in whichever of its two shapes the request uses. */
export function validateCreateBooking(req, res, next) {
  const schema = req.body && req.body.start !== undefined ? createBookingByInstantSchema : createBookingSchema;
  return validate(schema)(req, res, next);
}

/** Optional display name: no control characters (it ends up in email and calendar headers). */
const optionalName = z.string().max(100)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f\x7f]*$/, 'Name contains invalid characters')
  .nullish();
const optionalEmail = emailField.or(z.literal('')).nullish();

const dayTime = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM');
const dayField = z.object({
  enabled: z.boolean().nullish(),
  start: dayTime.nullish(),
  end: dayTime.nullish(),
}).refine((d) => !d.enabled || !d.start || !d.end || d.end.padStart(5, '0') > d.start.padStart(5, '0'),
  'End time must be after start time');

const WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** PUT /api/availability */
export const updateAvailabilitySchema = z.object({
  eventDuration: z.coerce.number().int().min(5).max(480).optional(),
  timezone: z.string().min(1).max(100)
    .refine((tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } },
      'Unknown timezone')
    .nullish(),
  name: optionalName,
  email: optionalEmail,
  organizerName: optionalName,
  organizerEmail: optionalEmail,
  bookingSlug: z.string().max(100).nullish(),
  ...Object.fromEntries(WEEK.map((day) => [day, dayField.optional()])),
  days: z.object(Object.fromEntries(WEEK.map((day) => [day, dayField.optional()]))).passthrough().nullish(),
}).passthrough();  // Other saved settings (buffers, notice, ...) pass through unchanged
