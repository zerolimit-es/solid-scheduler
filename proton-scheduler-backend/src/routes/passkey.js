/**
 * Passkey (WebAuthn) Routes — Thin wrapper around @zerolimit/passkey-mfa
 *
 * Provides ProtonScheduler-specific credential store (SQLite) and challenge store
 * (Redis + in-memory fallback) to the generic passkey router.
 */

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

const router = createPasskeyRouter({
  challengeStore,
  credentialStore,
  rpName: 'ProtonScheduler',
  rpId: getRpId(),
  origin: getAllowedOrigins(),
  getUserId: (req) => req.tenant?.id || req.session?.tenantId,
  getWebId: (req) => req.solidSession?.info?.webId || req.session?.webId,
});

export default router;
