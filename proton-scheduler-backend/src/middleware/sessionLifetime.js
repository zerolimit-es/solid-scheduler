/**
 * Server-side lifetime and revocation for sign-in sessions.
 *
 * The session lives in a signed cookie, which the browser holds. On its own
 * that cookie has no expiry the server can enforce (Max-Age is only advice
 * to the browser) and no way to be withdrawn: a copy taken from a browser
 * would keep working after the owner signed out. So each sign-in records
 * when it happened and a random ID inside the cookie, and every request is
 * checked against both:
 *
 *   - older than SESSION_LIFETIME_MS → signed out
 *   - ID on the revoked list (set at sign-out) → signed out
 *
 * A signed-in session without these fields (issued before this check
 * existed, or never completed) is signed out too.
 */

import crypto from 'crypto';
import { getDb } from '../cloud/models/database.js';

export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;

let tableReady = false;
function db() {
  const d = getDb();
  if (!tableReady) {
    d.exec(`CREATE TABLE IF NOT EXISTS revoked_sessions (
      sid TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    )`);
    tableReady = true;
  }
  return d;
}

/** Mark the session as freshly signed in. Call once the sign-in has succeeded. */
export function startSession(req) {
  if (!req.session) return;
  req.session.sid = crypto.randomUUID();
  req.session.loginAt = Date.now();
}

/** Withdraw the current session: its cookie stops working everywhere. */
export function revokeSession(req) {
  const sid = req.session?.sid;
  if (typeof sid !== 'string' || !sid) return;
  const loginAt = Number(req.session.loginAt) || Date.now();
  const d = db();
  // Entries only matter until the session would have expired anyway
  d.prepare('DELETE FROM revoked_sessions WHERE expires_at < ?').run(Date.now());
  d.prepare('INSERT OR REPLACE INTO revoked_sessions (sid, expires_at) VALUES (?, ?)')
    .run(sid, loginAt + SESSION_LIFETIME_MS);
}

function isRevoked(sid) {
  return !!db().prepare('SELECT 1 FROM revoked_sessions WHERE sid = ?').get(sid);
}

/** Why a signed-in session must end, or null if it is still good. */
export function sessionProblem(session, now = Date.now()) {
  const loginAt = Number(session.loginAt);
  if (typeof session.sid !== 'string' || !session.sid || !Number.isFinite(loginAt)) return 'incomplete';
  if (loginAt > now + 60_000 || now - loginAt > SESSION_LIFETIME_MS) return 'expired';
  if (isRevoked(session.sid)) return 'revoked';
  return null;
}

/**
 * Sign out sessions that have expired or been revoked. Mount right after
 * the cookie session, before anything reads who is signed in. Leaves an
 * empty session in place (rather than none) so later middleware can use it.
 */
export function enforceSessionLifetime() {
  return (req, _res, next) => {
    const session = req.session;
    if (!session?.webId) return next();
    let problem;
    try {
      problem = sessionProblem(session);
    } catch (err) {
      // Cannot tell whether the session was revoked: fail closed
      console.error('[Session] Could not check session:', err.message);
      problem = 'unverifiable';
    }
    if (problem) {
      for (const key of Object.keys(session)) delete session[key];
    }
    next();
  };
}
