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

/** POST /api/public/:slug/book */
export const publicBookingSchema = z.object({
  date: dateField,
  time: timeField,
  name: nameField,
  email: z.string().email('Invalid email address'),
  notes: z.string().max(1000, 'Notes must be under 1000 characters').optional().default(''),
  teamMemberId: z.string().max(100).optional(),
  recurrence: z.object({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().positive().optional(),
    byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
  }).nullable().optional().default(null),
});

/** POST /api/bookings (authenticated) */
export const createBookingSchema = z.object({
  date: dateField,
  time: timeField,
  name: nameField,
  email: z.string().email('Invalid email address'),
  notes: z.string().max(1000, 'Notes must be under 1000 characters').optional().default(''),
  recurrence: z.object({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().positive().optional(),
    byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
  }).nullable().optional().default(null),
});

/** PUT /api/availability */
export const updateAvailabilitySchema = z.object({
  eventDuration: z.number().int().min(5).max(480).optional(),
  timezone: z.string().min(1).max(100).optional(),
  name: z.string().max(100).optional(),
  email: z.string().email().optional().or(z.literal('')),
  bookingSlug: z.string().max(100).optional(),
  monday: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }).optional(),
  tuesday: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }).optional(),
  wednesday: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }).optional(),
  thursday: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }).optional(),
  friday: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }).optional(),
  saturday: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }).optional(),
  sunday: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }).optional(),
}).passthrough();  // Allow additional fields during migration
