/**
 * SolidScheduler Configuration
 * Centralized configuration management with environment variables
 */

import 'dotenv/config';

const nodeEnv = process.env.NODE_ENV || 'development';

// Validate critical secrets in production
if (nodeEnv === 'production') {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters in production');
  }
}

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv,
  baseUrl: process.env.BASE_URL || 'http://localhost:3001',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  domain: process.env.DOMAIN || null,

  // Session
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',

  // Redis (optional — falls back to in-memory if unset)
  redisUrl: process.env.REDIS_URL || null,

  // Solid/Inrupt
  solid: {
    defaultIdp: process.env.DEFAULT_SOLID_IDP || 'https://login.inrupt.com',
    clientId: process.env.SOLID_CLIENT_ID || undefined,
    clientSecret: process.env.SOLID_CLIENT_SECRET || undefined,
  },

  // Email (SMTP)
  email: {
    host: process.env.SMTP_HOST || '127.0.0.1',
    port: parseInt(process.env.SMTP_PORT || '1025', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || 'noreply@solidscheduler.local',
  },

  // Pod Paths
  pod: {
    schedulerPath: process.env.POD_SCHEDULER_PATH || 'solid-scheduler',
    availabilityFile: process.env.POD_AVAILABILITY_FILE || 'availability.ttl',
    bookingsContainer: process.env.POD_BOOKINGS_CONTAINER || 'bookings',
    publicProfile: process.env.POD_PUBLIC_PROFILE || 'public-profile.ttl',
  },

  // CalDAV (optional): copy one account's bookings to a CalDAV calendar.
  // CALDAV_SERVER_URL is the calendar collection URL. CALDAV_BOOKING_SLUG
  // names the account (booking page) whose bookings are synced; it is
  // required so other accounts' bookings never reach this calendar.
  caldav: {
    serverUrl: process.env.CALDAV_SERVER_URL || '',
    username: process.env.CALDAV_USERNAME || '',
    password: process.env.CALDAV_PASSWORD || '',
    bookingSlug: (process.env.CALDAV_BOOKING_SLUG || '').trim().toLowerCase(),
    enabled: process.env.CALDAV_ENABLED === 'true',
  },
};

export default config;
