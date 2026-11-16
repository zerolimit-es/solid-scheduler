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

// Number of reverse proxies between visitors and this server. Express uses
// it to read the visitor's address and scheme from X-Forwarded-* headers:
// too low and every visitor shares one rate-limit bucket (the proxy's
// address); too high and visitors can spoof their address.
function parseTrustProxy(value) {
  if (value === undefined || value === '') return 1;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error('TRUST_PROXY must be a whole number of proxy hops (0-10)');
  }
  return hops;
}

// SMTP transport security. `secure` means TLS from the first byte (port 465).
// Port 587 speaks plain text first and upgrades with STARTTLS, so
// SMTP_SECURE=true there cannot work as written; it is read as "TLS
// required" instead, which is what it is meant to say.
function emailSecurity(port) {
  const wantsTls = process.env.SMTP_SECURE === 'true';
  if (wantsTls && port === 587) {
    console.warn('[Email] SMTP_SECURE=true with port 587: using STARTTLS (set SMTP_SECURE=false, or use port 465 for implicit TLS)');
    return { secure: false, requireTLS: true };
  }
  return { secure: wantsTls, requireTLS: false };
}
const smtpPort = parseInt(process.env.SMTP_PORT || '1025', 10);

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv,
  baseUrl: process.env.BASE_URL || 'http://localhost:3001',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  domain: process.env.DOMAIN || null,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // Let users set a Pod URL on a private network address (a Pod server on
  // the same LAN or Docker network as this server). Off by default.
  allowPrivatePodHosts: process.env.ALLOW_PRIVATE_POD_HOSTS === 'true',

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

  // Email (SMTP). One set of settings for every email the app sends.
  // SMTP_FROM is the sender address; EMAIL_FROM is its older name.
  email: {
    host: process.env.SMTP_HOST || '127.0.0.1',
    port: smtpPort,
    ...emailSecurity(smtpPort),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.EMAIL_FROM || 'noreply@solidscheduler.local',
    fromName: process.env.SMTP_FROM_NAME || 'SolidScheduler',
  },

  // Fallbacks for an account that has not saved a name or email in its
  // settings (single-user installs set these once for the whole instance).
  organizer: {
    name: process.env.ORGANIZER_NAME || '',
    email: process.env.ORGANIZER_EMAIL || '',
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
