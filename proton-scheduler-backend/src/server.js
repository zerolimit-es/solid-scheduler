/**
 * SolidScheduler Backend Server
 *
 * A privacy-first scheduling application built on Solid/Inrupt.
 * Open-source edition — self-hosted, no cloud dependencies.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import lusca from 'lusca';
import cookieSession from 'cookie-session';
import config from './config/index.js';
import { solidSessionMiddleware } from './middleware/auth.js';
import { loadTenant } from './cloud/middleware/tierEnforcement.js';
import { verifyEmailConfig } from './services/email.js';
import { closeRedis } from './services/redis.js';

// Route imports
import authRoutes, { rejectedLoginRedirect } from './routes/auth.js';
import passkeyRoutes from './routes/passkey.js';
import availabilityRoutes from './routes/availability.js';
import bookingsRoutes from './routes/bookings.js';
import publicRoutes from './routes/public.js';
import calendarFeedRoutes from './routes/calendar-feed.js';
import calendarRoutes from './routes/calendar.js';

const app = express();

// =============================================================================
// 1. Session + Auth
// =============================================================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", config.frontendUrl, "https://login.inrupt.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,   // required for Solid OIDC redirect flow
}));

// CORS
const corsOrigins = [config.frontendUrl];
if (config.nodeEnv === 'development') {
  corsOrigins.push('http://localhost:3000', 'http://localhost:5173');
}
app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.set("trust proxy", 1);

// Session handling (for Solid OIDC state)
const SESSION_COOKIE = 'solid-scheduler-session';
app.use(cookieSession({
  name: SESSION_COOKIE,
  secret: config.sessionSecret,
  maxAge: 24 * 60 * 60 * 1000,
  secure: config.nodeEnv === 'production',
  httpOnly: true,
  sameSite: 'lax',
}));

// Solid session middleware
app.use(solidSessionMiddleware());

// Tenant for the signed-in WebID (created on first sign-in). Routes key
// per-account state on req.tenant: booking slug, passkeys, feed tokens, usage.
app.use(loadTenant());

// =============================================================================
// CSRF protection
// =============================================================================
// The API is consumed cross-origin by the SPA, so a token round-trip is
// impractical; instead, every state-changing request that rides on a session
// cookie must present an Origin (or Referer) matching an allowed origin.
// Cookieless requests (public booking calls, curl, calendar clients) are
// unaffected — without ambient cookie credentials there is nothing for a
// cross-site attacker to forge. Session cookies are additionally SameSite=Lax.

// Whether the request *arrived with* the session cookie. Checking the session
// contents instead doesn't work: solidSessionMiddleware() writes a session ID
// into every request's session, cookie or not, so every request looked
// cookie-backed and cookieless clients were rejected.
function arrivedWithSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return false;
  return header.split(';').some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
}

const allowedCsrfOrigins = new Set(
  [
    config.frontendUrl,
    config.baseUrl,
    ...(config.nodeEnv === 'development'
      ? ['http://localhost:3000', 'http://localhost:5173']
      : []),
  ]
    .filter(Boolean)
    .map((u) => { try { return new URL(u).origin; } catch { return null; } })
    .filter(Boolean)
);

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!arrivedWithSessionCookie(req)) return next();

  let origin = req.get('Origin') || null;
  if (!origin) {
    const referer = req.get('Referer');
    if (referer) { try { origin = new URL(referer).origin; } catch { origin = null; } }
  }
  if (!origin || !allowedCsrfOrigins.has(origin)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Cross-site request rejected',
    });
  }
  next();
});

// Token-based CSRF protection (lusca), applied globally so every route
// handler is covered. The SPA fetches a per-session token from
// GET /api/csrf-token and echoes it back in the X-CSRF-Token header on
// every state-changing request. Public visitor/calendar paths bypass
// token validation (prefix match): they serve cookieless clients, where
// CSRF does not apply — and the origin check above still covers any
// cookie-carrying request to them.
app.use(lusca.csrf({
  blocklist: ['/api/public/', '/book/', '/cal/'],
}));

// =============================================================================
// 2. Standard Middleware
// =============================================================================

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================================================
// 3. Routes
// =============================================================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API info
app.get('/api', (req, res) => {
  res.json({
    name: 'SolidScheduler API',
    version: '1.0.0',
    description: 'Privacy-first scheduling built on Solid',
    endpoints: {
      auth: '/api/auth',
      availability: '/api/availability',
      bookings: '/api/bookings',
      public: '/api/public',
    },
  });
});

// OIDC callback debug logging (runs before auth router handles the callback)
app.use('/api/auth/callback', (req, _res, next) => {
  const hasSession = !!req.session?.solidSessionId;
  const hasCode = !!req.query.code;
  const hasError = !!req.query.error;
  console.log('[Auth:Callback] Incoming — session:', hasSession,
    '| code:', hasCode, '| error:', hasError,
    hasError ? `| error_description: ${req.query.error_description}` : '',
    '| solidSessionId:', req.session?.solidSessionId || 'NONE');
  if (hasError) {
    console.error('[Auth:Callback] IDP returned error:', req.query.error, req.query.error_description);
  }
  next();
});

// CSRF token endpoint — the global lusca middleware has already computed
// the per-session token for this request.
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: res.locals._csrf });
});

// Core routes
// Mark session as MFA-verified after successful passkey auth-verify,
// so Pod reconnect doesn't re-trigger the passkey challenge.
app.use('/api/auth/passkey/auth-verify', (req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (body?.verified && body?.success) {
      req.session.mfaVerified = true;
    }
    return origJson(body);
  };
  next();
});
app.use('/api/auth/passkey', passkeyRoutes);
app.use('/api/auth/callback', rejectedLoginRedirect);
app.use('/api/auth', authRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/public', publicRoutes);
app.use('/book', publicRoutes);
app.use('/cal', calendarFeedRoutes);
// Same public feed under /api, which the bundled reverse proxies route to the backend
app.use('/api/calendar/feed', calendarFeedRoutes);
app.use('/api/calendar', calendarRoutes);

// =============================================================================
// Error Handling
// =============================================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`,
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  // lusca signals CSRF failures by setting res.statusCode = 403 before
  // calling next(err) — preserve that instead of collapsing to 500.
  const status = err.status || (res.statusCode >= 400 ? res.statusCode : 500);
  const isCsrf = /^CSRF token/.test(err.message || '');
  res.status(status).json({
    error: isCsrf ? 'Forbidden' : (err.name || 'Internal Server Error'),
    message: isCsrf ? 'CSRF token missing or invalid'
      : config.nodeEnv === 'development' ? err.message : 'Something went wrong',
  });
});

// =============================================================================
// Server Startup
// =============================================================================

async function startServer() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   SolidScheduler (Open Source)                               ║
║   Privacy-first scheduling on Solid                           ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const emailOk = await verifyEmailConfig();
  if (!emailOk) console.warn('⚠️  Email sending is disabled (SMTP not configured)');

  app.listen(config.port, () => {
    console.log(`
📡 Server running at ${config.baseUrl}
🔗 Frontend URL: ${config.frontendUrl}
🔐 Default IDP: ${config.solid.defaultIdp}

Environment: ${config.nodeEnv}
`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => { await closeRedis(); process.exit(0); });
process.on('SIGINT', async () => { await closeRedis(); process.exit(0); });

startServer().catch(console.error);
export default app;
