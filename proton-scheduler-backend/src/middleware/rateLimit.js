/**
 * Rate Limiting Middleware
 *
 * Protects unauthenticated public endpoints from request flooding.
 * The free-tier 25-booking limit only triggers after successful bookings —
 * without rate limiting, a script can saturate the endpoint with requests,
 * trigger email sends, and fill logs with no friction.
 *
 * Install: npm install express-rate-limit
 */

import rateLimit from 'express-rate-limit';

/**
 * Public booking endpoint: 10 attempts per 15 minutes per IP.
 *
 * Apply to: POST /api/public/:slug/book
 */
export const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,        // 15-minute window
  max: 10,                           // 10 booking attempts per IP per window
  standardHeaders: true,             // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,              // Disable X-RateLimit-* headers
  message: {
    error: 'Too many booking attempts. Please try again later.',
  },
});

/**
 * Public slot/availability lookup: 30 requests per minute per IP.
 *
 * Apply to: GET /api/public/:slug, GET /api/public/:slug/availability,
 *           GET /api/public/:slug/slots
 */
export const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,              // 1-minute window
  max: 30,                           // 30 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please try again shortly.',
  },
});

/**
 * Admin endpoints: 20 attempts per 15 minutes per IP.
 *
 * Protects against brute-force attacks on the admin Bearer token.
 * Apply to: /api/admin/*
 */
export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many admin requests. Please try again later.',
  },
});
