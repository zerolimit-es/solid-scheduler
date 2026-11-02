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
const memoryChallenges = createMemoryChallengeStore({ ttl: CHALLENGE_TTL });

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

const router = Router();
router.post('/auth-verify', requireOwnCredential);
router.use(passkeyRouter);

export default router;
