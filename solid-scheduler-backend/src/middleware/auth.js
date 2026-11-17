/**
 * Solid Authentication Middleware
 *
 * Thin wrapper around @zerolimit/solid-auth that configures the session
 * manager with SolidScheduler's Redis + in-memory storage and re-exports the
 * middleware functions for backward compatibility.
 */

import {
  SolidSessionManager,
  createMemoryStorage,
  createRedisStorage,
  createHybridStorage,
} from '@zerolimit/packages/solid-auth/core';
import {
  solidSessionMiddleware as _solidSessionMiddleware,
  requireAuth as _requireAuth,
} from '@zerolimit/packages/solid-auth/express';
import { getRedis } from '../services/redis.js';

// ── Storage setup ───────────────────────────────────────────────────────────
// Redis-backed with in-memory fallback (same strategy as before)
const memoryStorage = createMemoryStorage();

/**
 * Wrap a storage adapter to fix CSS (Community Solid Server) returning
 * client_secret_expires_at=0 (meaning "never expires" per RFC 7591 §3.2.1).
 *
 * The Inrupt library treats 0 as an actual epoch timestamp, so
 * Date.now()/1000 > 0 is always true → client is always "expired" →
 * re-registration during callback with no redirectUrl → redirect_uris: [null].
 *
 * This wrapper normalises expiresAt:"0" to a far-future value on write.
 */
function createCssExpiresAtFixStorage(inner) {
  return {
    get: (key) => inner.get(key),
    set: (key, value) => {
      if (typeof value === 'string' && value.includes('"expiresAt":"0"')) {
        value = value.replace('"expiresAt":"0"', '"expiresAt":"99999999999"');
      }
      return inner.set(key, value);
    },
    delete: (key) => inner.delete(key),
  };
}

function buildStorage() {
  const redis = getRedis();
  let storage;
  if (redis) {
    storage = createHybridStorage(
      createRedisStorage(redis, { prefix: 'solid:session:', ttl: 86400 }),
      memoryStorage,
    );
  } else {
    storage = memoryStorage;
  }
  return createCssExpiresAtFixStorage(storage);
}

// ── Session Manager (singleton) ─────────────────────────────────────────────
export const sessionManager = new SolidSessionManager({
  storage: buildStorage(),
  clientName: 'SolidScheduler',
});

// Re-export the fetchMap so sync.js and other modules can access it
export const solidFetchMap = sessionManager.fetchMap;

// ── Middleware (configured with our session manager) ────────────────────────

export function solidSessionMiddleware() {
  return _solidSessionMiddleware(sessionManager);
}

export function requireAuth() {
  return _requireAuth({
    mfaCheck: (req) => !!req.session?.mfaPending,
    mfaAllowedPaths: ['/api/auth/passkey', '/api/auth/status'],
  });
}

// ── Backward-compatible function exports ────────────────────────────────────

export async function getSession(sessionId) {
  return sessionManager.getSession(sessionId);
}

export function createFreshSession() {
  return sessionManager.createFreshSession();
}

export async function startLogin(session, options) {
  return sessionManager.startLogin(session, options);
}

export async function handleCallback(session, url) {
  return sessionManager.handleCallback(session, url);
}

export async function logout(session) {
  return sessionManager.logout(session);
}

export async function getAllSessions() {
  return sessionManager.getAllSessions();
}

export async function getAuthenticatedFetch(session, webId) {
  return sessionManager.getAuthenticatedFetch(session, webId);
}

export default {
  getSession,
  solidSessionMiddleware,
  requireAuth,
  startLogin,
  handleCallback,
  logout,
  getAllSessions,
  getAuthenticatedFetch,
};
