/**
 * Passkey (WebAuthn) Routes — Thin wrapper around @zerolimit/passkey-mfa
 *
 * Provides SolidScheduler-specific credential store (SQLite) and challenge store
 * (Redis + in-memory fallback) to the generic passkey router.
 */

import { Router } from 'express';
import { createPasskeyRouter } from '@zerolimit/packages/passkey-mfa/express';
import { createMemoryChallengeStore } from '@zerolimit/packages/passkey-mfa/core';
import { getDb } from '../cloud/models/database.js';
import { getRedis } from '../services/redis.js';
import config from '../config/index.js';

// ── Derive RP config ──

function getRpId() {
  try {
    const url = new URL(config.baseUrl);
    return url.hostname === 'localhost' ? 'localhost' : url.hostname.replace(/^app\./, '');
  } catch {
    return 'localhost';
  }
}

function getAllowedOrigins() {
  const origins = [config.frontendUrl];
  if (config.domain) {
    const proto = config.frontendUrl.startsWith('https') ? 'https' : 'http';
    origins.push(`${proto}://calendar.${config.domain}`);
  }
  return origins;
}

// ── Challenge store (Redis with in-memory fallback) ──

const CHALLENGE_TTL = 300; // 5 minutes
const CHALLENGE_PREFIX = 'passkey:challenge:';
// Takes the TTL in seconds as a plain number. Passing an options object made
// every in-memory challenge expire at once, so without Redis no passkey could
// be registered or verified.
const memoryChallenges = createMemoryChallengeStore(CHALLENGE_TTL);

const challengeStore = {
  async store(userId, challenge) {
    try {
      const redis = getRedis();
      if (redis) {
        await redis.set(CHALLENGE_PREFIX + userId, challenge, 'EX', CHALLENGE_TTL);
        return;
      }
    } catch {}
    await memoryChallenges.store(userId, challenge);
  },
  async get(userId) {
    try {
      const redis = getRedis();
      if (redis) {
        const val = await redis.get(CHALLENGE_PREFIX + userId);
        if (val) await redis.del(CHALLENGE_PREFIX + userId); // one-time use
        return val;
      }
    } catch {}
    return memoryChallenges.get(userId);
  },
};

// ── Credential store (SQLite adapter) ──

function mapRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    userId: row.tenant_id,
    credentialId: row.credential_id,
    publicKey: row.public_key,
    counter: row.counter,
    transports: row.transports,
    deviceName: row.device_name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

const credentialStore = {
  getByUser(userId) {
    return getDb().prepare('SELECT * FROM passkeys WHERE tenant_id = ?').all(userId).map(mapRow);
  },

  getByCredentialId(credentialId) {
    return mapRow(getDb().prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credentialId));
  },

  async save(record) {
    getDb().prepare(`
      INSERT INTO passkeys (id, tenant_id, credential_id, public_key, counter, transports, device_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.userId,
      record.credentialId,
      record.publicKey,
      record.counter,
      record.transports,
      record.deviceName,
    );
  },

  async remove(id, userId) {
    const result = getDb().prepare(
      'DELETE FROM passkeys WHERE id = ? AND tenant_id = ?'
    ).run(id, userId);
    return result.changes > 0;
  },

  async updateCounter(credentialId, newCounter) {
    getDb().prepare(
      'UPDATE passkeys SET counter = ?, last_used_at = CURRENT_TIMESTAMP WHERE credential_id = ?'
    ).run(newCounter, credentialId);
  },
};

// ── Build the router ──

const getUserId = (req) => req.tenant?.id || req.session?.tenantId;

const passkeyRouter = createPasskeyRouter({
  challengeStore,
  credentialStore,
  rpName: 'SolidScheduler',
  rpId: getRpId(),
  origin: getAllowedOrigins(),
  getUserId,
  getWebId: (req) => req.solidSession?.info?.webId || req.session?.webId,
});

/**
 * The generic passkey router looks the asserted credential up by credential
 * ID alone, across every account, and never checks whom it belongs to. On a
 * multi-user instance that would let a passkey registered on one account
 * satisfy another account's MFA. Reject any assertion whose credential is not
 * registered to the account being verified, before the router sees it.
 */
export function requireOwnCredential(req, res, next) {
  const userId = getUserId(req);
  const credentialId = req.body?.body?.id;
  // Let the router produce its own errors for missing user / malformed body.
  if (!userId || typeof credentialId !== 'string') return next();

  const passkey = credentialStore.getByCredentialId(credentialId);
  if (!passkey || String(passkey.userId) !== String(userId)) {
    return res.status(400).json({ error: 'Passkey not found' });
  }
  next();
}

// ── Fresh passkey check for passkey changes ──
//
// Removing a passkey, or adding one while the account already has some,
// changes what protects the account: removing the last passkey turns the
// sign-in check off. A signed-in session alone isn't enough for that (an
// unlocked computer, a stolen cookie), so these need a passkey check within
// the last few minutes. The first passkey needs none.

export const PASSKEY_REAUTH_WINDOW_MS = 5 * 60 * 1000;

/**
 * On a successful passkey check (sign-in or re-check), record it in the
 * session, bound to the account that passed it: the cookie session survives
 * signing in to another account in the same browser.
 */
export function recordPasskeyVerification(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400 && body?.success && body?.verified && req.session) {
      req.session.passkeyVerifiedAt = Date.now();
      req.session.passkeyVerifiedFor = String(getUserId(req));
      // Lets a Pod reconnect skip the sign-in challenge, for this WebID only
      req.session.mfaVerifiedWebId = req.solidSession?.info?.webId || req.session.webId;
    }
    return json(body);
  };
  next();
}

export function requireRecentPasskey(req, res, next) {
  const userId = getUserId(req);
  if (!userId) return next(); // the router answers with its own error
  if (credentialStore.getByUser(userId).length === 0) return next();

  const verifiedAt = Number(req.session?.passkeyVerifiedAt);
  const age = Date.now() - verifiedAt;
  const sameAccount = req.session?.passkeyVerifiedFor === String(userId);
  if (sameAccount && Number.isFinite(verifiedAt) && age >= 0 && age <= PASSKEY_REAUTH_WINDOW_MS) return next();

  return res.status(403).json({
    error: 'passkey_reauth_required',
    message: 'Confirm with one of your passkeys first.',
  });
}

const router = Router();
router.post('/auth-verify', requireOwnCredential, recordPasskeyVerification);
router.get('/register-options', requireRecentPasskey);
router.post('/register-verify', requireRecentPasskey);
router.delete('/:id', requireRecentPasskey);
router.use(passkeyRouter);

export default router;
