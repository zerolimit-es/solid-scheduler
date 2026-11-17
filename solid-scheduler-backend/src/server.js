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
import { solidSessionMiddleware, requireAuth, sessionManager } from './middleware/auth.js';
import { checkPublicUrl } from './utils/public-host.js';
import { enforceSessionLifetime } from './middleware/sessionLifetime.js';
import { loadTenant } from './cloud/middleware/tenant.js';
import { verifyEmailConfig } from './services/email.js';
import { closeRedis } from './services/redis.js';

// Route imports
import authRoutes from './routes/auth.js';
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

app.set('trust proxy', config.trustProxy);

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

// End sessions that are past their lifetime or were signed out elsewhere.
// Must run before anything trusts the cookie's identity.
app.use(enforceSessionLifetime());

// Solid session middleware
app.use(solidSessionMiddleware());

// A live Solid session only counts together with the cookie that completed
// its sign-in. A copy of the cookie taken mid-login (before the callback
// wrote the WebID, the passkey flag and the session lifetime into it) names
// the same Solid session, and would otherwise be signed in with none of
// those checks.
app.use((req, _res, next) => {
  const live = req.solidSession?.info;
  if (live?.isLoggedIn && req.session?.webId !== live.webId && !req.path.startsWith('/api/auth/callback')) {
    delete req.user;
    req.solidSession = sessionManager.createFreshSession();
  }
  next();
});

// The Solid middleware writes a fresh session ID into the session of every
// request, which would hand a cookie to each anonymous visitor of a booking
// page. A request that arrived without the cookie has no session to keep:
// drop the ID again. (Sign-in sets its own when it starts.)
app.use((req, _res, next) => {
  if (!arrivedWithSessionCookie(req) && req.session) delete req.session.solidSessionId;
  next();
});

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

// Whether the request *arrived with* the session cookie (as opposed to
// whatever the middleware has put into req.session since).
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
const csrfProtection = lusca.csrf({
  blocklist: ['/api/public/', '/book/', '/cal/'],
});
app.use((req, res, next) => {
  // lusca stores its secret in the session on first contact, cookie and all.
  // A read-only request without a session cookie has nothing to protect and
  // needs no token, so it gets no cookie; the token endpoint is where a
  // browser's session starts.
  const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (readOnly && !arrivedWithSessionCookie(req) && req.path !== '/api/csrf-token') return next();
  csrfProtection(req, res, next);
});

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
app.use('/api/auth/passkey', passkeyRoutes);
// Setting a Pod URL by hand: only for a fully signed-in user (not while a
// passkey check is pending), and only to a host on the public internet, since
// the server will send this user's Pod requests there.
app.put('/api/auth/pod-url', requireAuth(), async (req, res, next) => {
  if (config.allowPrivatePodHosts) return next();
  const podUrl = req.body?.podUrl;
  if (typeof podUrl !== 'string') return next(); // the router answers with its own error
  const check = await checkPublicUrl(podUrl);
  if (!check.ok) {
    console.warn('[Auth] Rejected Pod URL:', check.reason);
    return res.status(400).json({ error: 'This Pod URL cannot be used: its host is not reachable on the public internet.' });
  }
  next();
});
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

// Express recognises an error handler by its four parameters
app.use((err, req, res, _next) => {
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
