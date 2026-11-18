/**
 * Confirmed notification emails (see migrations/009_add_email_verification.js).
 *
 * Booking emails for an organizer go to the address in their settings only
 * once its owner has confirmed it, or to the operator's ORGANIZER_EMAIL.
 */
import crypto from 'node:crypto';
import { getDb } from './database.js';
import config from '../../config/index.js';

export const LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const RESEND_AFTER_MS = 60 * 1000;

const normalize = (email) => String(email ?? '').trim().toLowerCase();
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** True for an address an organizer has confirmed, or the operator's ORGANIZER_EMAIL. */
export function isConfirmedOrganizerEmail(address) {
  const email = normalize(address);
  if (!email) return false;
  if (email === normalize(config.organizer.email)) return true;
  return !!getDb().prepare('SELECT 1 FROM email_verifications WHERE verified_email = ?').get(email);
}

/** `address` when it may receive organizer emails, otherwise null. */
export function organizerRecipient(address) {
  return isConfirmedOrganizerEmail(address) ? String(address).trim() : null;
}

/**
 * Where an account's notification email stands.
 * @returns {'none' | 'verified' | 'pending' | 'unconfirmed'}
 */
export function verificationStatus(tenantId, email) {
  const wanted = normalize(email);
  if (!wanted) return 'none';
  if (wanted === normalize(config.organizer.email)) return 'verified';
  const row = tenantId
    ? getDb().prepare('SELECT * FROM email_verifications WHERE tenant_id = ?').get(tenantId)
    : null;
  if (row?.verified_email === wanted) return 'verified';
  if (row?.pending_email === wanted && row.expires_at > Date.now()) return 'pending';
  return 'unconfirmed';
}

/**
 * Start confirming `email` for an account: a new link token, replacing any
 * earlier one. Refused (null) when a link went to the same address less than
 * a minute ago.
 * @returns {{ token: string } | null}
 */
export function startVerification(tenantId, email) {
  const wanted = normalize(email);
  const db = getDb();
  const row = db.prepare('SELECT * FROM email_verifications WHERE tenant_id = ?').get(tenantId);
  const now = Date.now();
  if (row?.pending_email === wanted && row.sent_at && now - row.sent_at < RESEND_AFTER_MS) return null;
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`
    INSERT INTO email_verifications (tenant_id, pending_email, token_hash, expires_at, sent_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      pending_email = excluded.pending_email, token_hash = excluded.token_hash,
      expires_at = excluded.expires_at, sent_at = excluded.sent_at
  `).run(tenantId, wanted, hash(token), now + LINK_LIFETIME_MS, now);
  return { token };
}

/**
 * Confirm the address a link was sent to.
 * @returns {{ ok: true, email: string } | { ok: false, reason: 'unknown' | 'expired' }}
 */
export function confirmVerification(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return { ok: false, reason: 'unknown' };
  const db = getDb();
  const row = db.prepare('SELECT * FROM email_verifications WHERE token_hash = ?').get(hash(token));
  if (!row) return { ok: false, reason: 'unknown' };
  if (!(row.expires_at > Date.now())) return { ok: false, reason: 'expired' };
  db.prepare(`
    UPDATE email_verifications
    SET verified_email = pending_email, pending_email = NULL, token_hash = NULL, expires_at = NULL
    WHERE tenant_id = ?
  `).run(row.tenant_id);
  return { ok: true, email: row.pending_email };
}
