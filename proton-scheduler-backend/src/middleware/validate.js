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

/** POST /api/public/:slug/book */
export const publicBookingSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM'),
  name: z.string().min(1, 'Name is required').max(100, 'Name must be under 100 characters'),
  email: z.string().email('Invalid email address'),
  notes: z.string().max(1000, 'Notes must be under 1000 characters').optional().default(''),
  teamMemberId: z.string().optional(),
  recurrence: z.object({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().positive().optional(),
    byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
  }).nullable().optional().default(null),
});

/** POST /api/bookings (authenticated) */
export const createBookingSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:MM'),
  name: z.string().min(1, 'Name is required').max(100, 'Name must be under 100 characters'),
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
