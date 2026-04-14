/**
 * SolidScheduler Backend Server
 *
 * A privacy-first scheduling application built on Solid/Inrupt.
 * Open-source edition — self-hosted, no cloud dependencies.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieSession from 'cookie-session';
import config from './config/index.js';
import { solidSessionMiddleware } from './middleware/auth.js';
import { verifyEmailConfig } from './services/email.js';
import { closeRedis } from './services/redis.js';

// Route imports
import authRoutes from './routes/auth.js';
import passkeyRoutes from './routes/passkey.js';
import availabilityRoutes from './routes/availability.js';
import bookingsRoutes from './routes/bookings.js';
import publicRoutes from './routes/public.js';
import calendarFeedRoutes from './routes/calendar-feed.js';

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
app.use(cookieSession({
  name: 'solid-scheduler-session',
  secret: config.sessionSecret,
  maxAge: 24 * 60 * 60 * 1000,
  secure: config.nodeEnv === 'production',
  httpOnly: true,
  sameSite: 'lax',
}));

// Solid session middleware
app.use(solidSessionMiddleware());

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
app.use('/api/auth', authRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/public', publicRoutes);
app.use('/book', publicRoutes);
app.use('/cal', calendarFeedRoutes);

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
  res.status(err.status || 500).json({
    error: err.name || 'Internal Server Error',
    message: config.nodeEnv === 'development' ? err.message : 'Something went wrong',
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
