import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { runMigrations } from './migrations/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/solid-scheduler.db');
const DB_KEY = process.env.DB_ENCRYPTION_KEY || '';

let db;

export function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);

    // ── Encryption (AES-256 via SQLite3MultipleCiphers) ──
    if (DB_KEY) {
      // Single quotes in the key must be doubled so the key can't terminate
      // the pragma string literal early.
      const quotedKey = DB_KEY.replace(/'/g, "''");
      const dbExists = fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0;
      if (dbExists) {
        // Try opening as encrypted first
        try {
          db.pragma(`key='${quotedKey}'`);
          // Verify the key works by reading a table
          db.pragma('schema_version');
        } catch {
          // DB is unencrypted — close, reopen, and encrypt in-place
          db.close();
          db = new Database(DB_PATH);
          db.pragma(`rekey='${quotedKey}'`);
          console.log('[DB] Encrypted existing database with AES-256');
        }
      } else {
        // New DB — set encryption key from the start
        db.pragma(`key='${quotedKey}'`);
      }
    }

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    runMigrations(db);
  }
  return db;
}

// The tables this edition uses. Tables from the former hosted edition
// (usage tracking, API keys, webhooks, branding, CalDAV settings, teams) are
// no longer created; databases that already have them keep them, unused.
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      webid TEXT,
      solid_pod_url TEXT,
      tier TEXT NOT NULL DEFAULT 'free',
      stripe_customer_id TEXT UNIQUE,
      stripe_subscription_id TEXT,
      subscription_status TEXT DEFAULT 'none',
      subdomain TEXT UNIQUE,
      custom_domain TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admin_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(email);
    CREATE INDEX IF NOT EXISTS idx_tenants_webid ON tenants(webid);
    CREATE INDEX IF NOT EXISTS idx_tenants_stripe_customer ON tenants(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants(subdomain);

  `);
}

const tenantStmts = {};

function getTenantStmts() {
  if (!tenantStmts.create) {
    const d = getDb();
    tenantStmts.create = d.prepare('INSERT INTO tenants (id, email, webid, solid_pod_url, subdomain) VALUES (?, ?, ?, ?, ?)');
    tenantStmts.getById = d.prepare('SELECT * FROM tenants WHERE id = ?');
    tenantStmts.getByEmail = d.prepare('SELECT * FROM tenants WHERE email = ?');
    tenantStmts.getByWebId = d.prepare('SELECT * FROM tenants WHERE webid = ?');
    tenantStmts.getBySubdomain = d.prepare('SELECT * FROM tenants WHERE subdomain = ?');
    tenantStmts.getByBookingSlug = d.prepare('SELECT * FROM tenants WHERE booking_slug = ?');
    tenantStmts.updateBookingSlug = d.prepare('UPDATE tenants SET booking_slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    tenantStmts.updateEmail = d.prepare('UPDATE tenants SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
  }
  return tenantStmts;
}

export function createTenant({ email, webid, solidPodUrl, subdomain }) {
  const id = crypto.randomUUID();
  const stmts = getTenantStmts();
  stmts.create.run(id, email, webid, solidPodUrl, subdomain);
  return stmts.getById.get(id);
}

export function getTenantById(id) {
  return getTenantStmts().getById.get(id);
}

export function getTenantByEmail(email) {
  return getTenantStmts().getByEmail.get(email);
}

export function getTenantByWebId(webid) {
  return getTenantStmts().getByWebId.get(webid);
}

export function getTenantBySubdomain(subdomain) {
  return getTenantStmts().getBySubdomain.get(subdomain);
}

// ---------------------------------------------------------------------------
// Phase 2 — Task 12: Direct slug → tenant lookup
// Replaces the fragile email-indirection pattern in public.js where the
// booking page slug had no structural link to the tenant record.
// ---------------------------------------------------------------------------

export function getTenantBySlug(bookingSlug) {
  return getTenantStmts().getByBookingSlug.get(bookingSlug);
}

export function updateBookingSlug(tenantId, bookingSlug) {
  const normalized = bookingSlug ? bookingSlug.toLowerCase() : bookingSlug;
  return getTenantStmts().updateBookingSlug.run(normalized, tenantId);
}

/** Thrown by changeBookingSlug when the wanted slug cannot be claimed. */
export class SlugTakenError extends Error {
  constructor(slug) {
    super(`Booking slug "${slug}" is already taken`);
    this.name = 'SlugTakenError';
    this.status = 409;
  }
}

function tableExists(d, name) {
  return !!d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Change a tenant's booking slug and carry its data along.
 *
 * Bookings and the availability row are keyed by slug, so changing only the
 * tenant row would leave them behind under the old slug: gone from the
 * owner's account, and handed to whoever claims that slug next. This moves
 * them in the same transaction.
 *
 * A slug is refused when another tenant holds it, or when rows already exist
 * under it that are not this tenant's (left over from an earlier rename),
 * since claiming it would expose them.
 *
 * @returns {{ changed: boolean, from: string|null, to: string }}
 * @throws {SlugTakenError}
 */
export function changeBookingSlug(tenantId, bookingSlug) {
  if (typeof bookingSlug !== 'string' || bookingSlug === '') {
    throw new Error('changeBookingSlug requires a slug');
  }
  const to = bookingSlug.toLowerCase();
  const d = getDb();
  return d.transaction(() => {
    const tenant = d.prepare('SELECT id, booking_slug FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) throw new Error('Tenant not found');
    const from = tenant.booking_slug || null;
    if (from === to) return { changed: false, from, to };

    const holder = d.prepare('SELECT id FROM tenants WHERE booking_slug = ?').get(to);
    if (holder && holder.id !== tenantId) throw new SlugTakenError(to);

    const hasBookings = tableExists(d, 'bookings');
    const hasAvailability = tableExists(d, 'availability');
    const leftover =
      (hasBookings && d.prepare('SELECT 1 FROM bookings WHERE slug = ? LIMIT 1').get(to)) ||
      (hasAvailability && d.prepare('SELECT 1 FROM availability WHERE slug = ? LIMIT 1').get(to));
    if (leftover) throw new SlugTakenError(to);

    if (from) {
      if (hasBookings) d.prepare('UPDATE bookings SET slug = ? WHERE slug = ?').run(to, from);
      if (hasAvailability) d.prepare('UPDATE availability SET slug = ? WHERE slug = ?').run(to, from);
    }
    d.prepare('UPDATE tenants SET booking_slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(to, tenantId);
    return { changed: true, from, to };
  })();
}

export function updateTenantEmail(tenantId, email) {
  return getTenantStmts().updateEmail.run(email, tenantId);
}

// --- Admin Settings ---

export function getAdminSetting(key) {
  const row = getDb().prepare('SELECT value FROM admin_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setAdminSetting(key, value) {
  getDb().prepare(`
    INSERT INTO admin_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key)
    DO UPDATE SET value = ?, updated_at = CURRENT_TIMESTAMP
  `).run(key, value, value);
}

export function close() {
  if (db) { db.close(); db = null; }
}
