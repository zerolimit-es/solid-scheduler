import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { runMigrations } from './migrations/runner.js';
import { checkLimit } from '../config/tiers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/proton-scheduler.db');
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
      const dbExists = fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0;
      if (dbExists) {
        // Try opening as encrypted first
        try {
          db.pragma(`key='${DB_KEY}'`);
          // Verify the key works by reading a table
          db.pragma('schema_version');
        } catch {
          // DB is unencrypted — close, reopen, and encrypt in-place
          db.close();
          db = new Database(DB_PATH);
          db.pragma(`rekey='${DB_KEY}'`);
          console.log('[DB] Encrypted existing database with AES-256');
        }
      } else {
        // New DB — set encryption key from the start
        db.pragma(`key='${DB_KEY}'`);
      }
    }

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
    runMigrations(db);
  }
  return db;
}

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

    CREATE TABLE IF NOT EXISTS usage_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      metric TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      period TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(tenant_id, metric, period)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      name TEXT,
      last_used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      revoked_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL REFERENCES webhooks(id),
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      delivered_at DATETIME,
      next_retry_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS branding (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
      company_name TEXT,
      logo_url TEXT,
      primary_color TEXT DEFAULT '#219EBC',
      accent_color TEXT DEFAULT '#FFB703',
      background_color TEXT DEFAULT '#0B1D27',
      text_color TEXT DEFAULT '#E8F4FA',
      hide_proton_badge INTEGER NOT NULL DEFAULT 0,
      custom_css TEXT,
      light_background_color TEXT,
      light_text_color TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_usage_tenant_period ON usage_tracking(tenant_id, period);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_webhooks_tenant ON webhooks(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at);

      CREATE TABLE IF NOT EXISTS caldav_config (
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
        server_url TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        password TEXT NOT NULL DEFAULT '',
        calendar_name TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
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
    tenantStmts.getByStripeCustomer = d.prepare('SELECT * FROM tenants WHERE stripe_customer_id = ?');
    tenantStmts.getBySubdomain = d.prepare('SELECT * FROM tenants WHERE subdomain = ?');
    tenantStmts.getByBookingSlug = d.prepare('SELECT * FROM tenants WHERE booking_slug = ?');
    tenantStmts.updateStripe = d.prepare('UPDATE tenants SET stripe_customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    tenantStmts.updateSubscription = d.prepare('UPDATE tenants SET stripe_subscription_id = ?, subscription_status = ?, tier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    tenantStmts.updateTier = d.prepare('UPDATE tenants SET tier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    tenantStmts.updateBookingSlug = d.prepare('UPDATE tenants SET booking_slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    tenantStmts.updateEmail = d.prepare('UPDATE tenants SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    tenantStmts.count = d.prepare('SELECT COUNT(*) as count FROM tenants');
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

export function getTenantByStripeCustomer(stripeCustomerId) {
  return getTenantStmts().getByStripeCustomer.get(stripeCustomerId);
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

export function updateStripeCustomer(tenantId, stripeCustomerId) {
  return getTenantStmts().updateStripe.run(stripeCustomerId, tenantId);
}

export function updateSubscription(tenantId, { subscriptionId, status, tier }) {
  return getTenantStmts().updateSubscription.run(subscriptionId, status, tier, tenantId);
}

export function updateTier(tenantId, tier) {
  return getTenantStmts().updateTier.run(tier, tenantId);
}

export function updateTenantEmail(tenantId, email) {
  return getTenantStmts().updateEmail.run(email, tenantId);
}

function getCurrentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function incrementUsage(tenantId, metric, amount = 1) {
  const d = getDb();
  const period = getCurrentPeriod();
  d.prepare(`
    INSERT INTO usage_tracking (tenant_id, metric, count, period)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id, metric, period)
    DO UPDATE SET count = count + ?, updated_at = CURRENT_TIMESTAMP
  `).run(tenantId, metric, amount, period, amount);
}

export function getUsage(tenantId, metric) {
  const d = getDb();
  const period = getCurrentPeriod();
  const row = d.prepare('SELECT count FROM usage_tracking WHERE tenant_id = ? AND metric = ? AND period = ?').get(tenantId, metric, period);
  return row ? row.count : 0;
}

/**
 * Atomically check usage limit and increment in a single transaction.
 * Prevents race conditions where concurrent requests pass the check before
 * any increment occurs.
 */
export function atomicCheckAndIncrement(tenantId, metric, tier, limitKey) {
  const d = getDb();
  const period = getCurrentPeriod();

  // Run check + increment inside a transaction so they're atomic
  const txn = d.transaction(() => {
    const row = d.prepare('SELECT count FROM usage_tracking WHERE tenant_id = ? AND metric = ? AND period = ?').get(tenantId, metric, period);
    const currentUsage = row ? row.count : 0;
    const result = checkLimit(tier, limitKey, currentUsage);
    if (!result.allowed) return { allowed: false, limit: result.limit, current: result.current };

    d.prepare(`
      INSERT INTO usage_tracking (tenant_id, metric, count, period)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(tenant_id, metric, period)
      DO UPDATE SET count = count + 1, updated_at = CURRENT_TIMESTAMP
    `).run(tenantId, metric, period);

    return { allowed: true, limit: result.limit, current: currentUsage + 1 };
  });

  return txn();
}

export function decrementUsage(tenantId, metric, amount = 1) {
  const d = getDb();
  const period = getCurrentPeriod();
  d.prepare(`
    UPDATE usage_tracking SET count = MAX(0, count - ?), updated_at = CURRENT_TIMESTAMP
    WHERE tenant_id = ? AND metric = ? AND period = ?
  `).run(amount, tenantId, metric, period);
}

export function getUsageSummary(tenantId) {
  const d = getDb();
  const period = getCurrentPeriod();
  const rows = d.prepare('SELECT metric, count FROM usage_tracking WHERE tenant_id = ? AND period = ?').all(tenantId, period);
  const summary = {};
  for (const row of rows) summary[row.metric] = row.count;
  return summary;
}

export function createApiKey(tenantId, name) {
  const raw = `ps_live_${crypto.randomBytes(32).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(raw).digest('hex');
  const keyPrefix = raw.slice(0, 12);
  const id = crypto.randomUUID();
  getDb().prepare('INSERT INTO api_keys (id, tenant_id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?, ?)').run(id, tenantId, keyHash, keyPrefix, name);
  return { id, key: raw, prefix: keyPrefix };
}

export function validateApiKey(rawKey) {
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const row = getDb().prepare('SELECT ak.*, t.* FROM api_keys ak JOIN tenants t ON ak.tenant_id = t.id WHERE ak.key_hash = ? AND ak.revoked_at IS NULL').get(keyHash);
  if (row) getDb().prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE key_hash = ?').run(keyHash);
  return row;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export function createWebhook(tenantId, { url, events, description }) {
  const id = crypto.randomUUID();
  const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  const eventsJson = JSON.stringify(events || []);
  getDb().prepare(
    'INSERT INTO webhooks (id, tenant_id, url, secret, events, description) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, tenantId, url, secret, eventsJson, description || null);
  return { id, url, secret, events: events || [], description, active: true };
}

export function getWebhooksByTenant(tenantId) {
  const rows = getDb().prepare(
    'SELECT * FROM webhooks WHERE tenant_id = ? ORDER BY created_at DESC'
  ).all(tenantId);
  return rows.map(row => ({ ...row, events: JSON.parse(row.events), active: !!row.active }));
}

export function getWebhookById(id, tenantId) {
  const row = getDb().prepare('SELECT * FROM webhooks WHERE id = ? AND tenant_id = ?').get(id, tenantId);
  if (!row) return null;
  return { ...row, events: JSON.parse(row.events), active: !!row.active };
}

export function updateWebhook(id, tenantId, updates) {
  const fields = [];
  const values = [];
  if (updates.url !== undefined) { fields.push('url = ?'); values.push(updates.url); }
  if (updates.events !== undefined) { fields.push('events = ?'); values.push(JSON.stringify(updates.events)); }
  if (updates.active !== undefined) { fields.push('active = ?'); values.push(updates.active ? 1 : 0); }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
  if (fields.length === 0) return null;
  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id, tenantId);
  const result = getDb().prepare(
    `UPDATE webhooks SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`
  ).run(...values);
  return result.changes > 0 ? getWebhookById(id, tenantId) : null;
}

export function deleteWebhook(id, tenantId) {
  const d = getDb();
  d.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(id);
  const result = d.prepare('DELETE FROM webhooks WHERE id = ? AND tenant_id = ?').run(id, tenantId);
  return result.changes > 0;
}

export function getActiveWebhooksForEvent(tenantId, eventType) {
  const rows = getDb().prepare(
    'SELECT * FROM webhooks WHERE tenant_id = ? AND active = 1'
  ).all(tenantId);
  return rows
    .map(row => ({ ...row, events: JSON.parse(row.events), active: true }))
    .filter(wh => wh.events.length === 0 || wh.events.includes(eventType));
}

export function createWebhookDelivery(webhookId, eventType, payload) {
  const id = crypto.randomUUID();
  getDb().prepare(
    'INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload) VALUES (?, ?, ?, ?)'
  ).run(id, webhookId, eventType, JSON.stringify(payload));
  return id;
}

export function updateWebhookDelivery(id, { responseStatus, responseBody, deliveredAt, nextRetryAt, attempts }) {
  const fields = [];
  const values = [];
  if (responseStatus !== undefined) { fields.push('response_status = ?'); values.push(responseStatus); }
  if (responseBody !== undefined) { fields.push('response_body = ?'); values.push(responseBody); }
  if (deliveredAt !== undefined) { fields.push('delivered_at = ?'); values.push(deliveredAt); }
  if (nextRetryAt !== undefined) { fields.push('next_retry_at = ?'); values.push(nextRetryAt); }
  if (attempts !== undefined) { fields.push('attempts = ?'); values.push(attempts); }
  if (fields.length === 0) return;
  values.push(id);
  getDb().prepare(`UPDATE webhook_deliveries SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getWebhookDeliveries(webhookId, limit = 20) {
  return getDb().prepare(
    'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(webhookId, limit);
}

export function getPendingDeliveries() {
  return getDb().prepare(
    "SELECT wd.*, w.url, w.secret FROM webhook_deliveries wd JOIN webhooks w ON wd.webhook_id = w.id WHERE wd.delivered_at IS NULL AND wd.attempts < 5 AND (wd.next_retry_at IS NULL OR wd.next_retry_at <= datetime('now'))"
  ).all();
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

export function getBranding(tenantId) {
  return getDb().prepare('SELECT * FROM branding WHERE tenant_id = ?').get(tenantId) || null;
}

export function upsertBranding(tenantId, updates) {
  const existing = getBranding(tenantId);
  if (existing) {
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(updates)) {
      if (key === 'tenant_id') continue;
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      fields.push(`${col} = ?`);
      values.push(val);
    }
    if (fields.length === 0) return existing;
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(tenantId);
    getDb().prepare(`UPDATE branding SET ${fields.join(', ')} WHERE tenant_id = ?`).run(...values);
  } else {
    const cols = ['tenant_id'];
    const placeholders = ['?'];
    const values = [tenantId];
    for (const [key, val] of Object.entries(updates)) {
      if (key === 'tenant_id') continue;
      cols.push(key.replace(/([A-Z])/g, '_$1').toLowerCase());
      placeholders.push('?');
      values.push(val);
    }
    getDb().prepare(`INSERT INTO branding (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`).run(...values);
  }
  return getBranding(tenantId);
}

export function deleteBranding(tenantId) {
  const result = getDb().prepare('DELETE FROM branding WHERE tenant_id = ?').run(tenantId);
  return result.changes > 0;
}

// --- Tenant Stats ---

export function getTenantCountByTier() {
  const rows = getDb().prepare(
    'SELECT tier, COUNT(*) as count FROM tenants GROUP BY tier'
  ).all();
  const result = { free: 0, pro: 0, business: 0 };
  for (const row of rows) result[row.tier] = row.count;
  result.total = result.free + result.pro + result.business;
  return result;
}

export function getTenantCountBySubscriptionStatus() {
  const rows = getDb().prepare(
    "SELECT COALESCE(subscription_status, 'none') as status, COUNT(*) as count FROM tenants GROUP BY status"
  ).all();
  const result = {};
  for (const row of rows) result[row.status] = row.count;
  return result;
}

export function getRecentTenants(limit = 10) {
  return getDb().prepare(
    'SELECT id, email, tier, subscription_status, created_at FROM tenants ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

export function getTenantSignupsByMonth() {
  return getDb().prepare(`
    SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
    FROM tenants
    GROUP BY month
    ORDER BY month DESC
    LIMIT 12
  `).all();
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

export function getAllAdminSettings() {
  const rows = getDb().prepare('SELECT key, value, updated_at FROM admin_settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = { value: row.value, updatedAt: row.updated_at };
  return settings;
}

export function close() {
  if (db) { db.close(); db = null; }
}

// CalDAV Config
export function getCaldavConfig(tenantId) {
  return getDb().prepare('SELECT * FROM caldav_config WHERE tenant_id = ?').get(tenantId);
}

export function saveCaldavConfig(tenantId, config) {
  const existing = getCaldavConfig(tenantId);
  if (existing) {
    getDb().prepare(
      'UPDATE caldav_config SET server_url = ?, username = ?, password = ?, calendar_name = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?'
    ).run(config.server_url, config.username, config.password, config.calendar_name, config.enabled, tenantId);
  } else {
    getDb().prepare(
      'INSERT INTO caldav_config (tenant_id, server_url, username, password, calendar_name, enabled) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(tenantId, config.server_url, config.username, config.password, config.calendar_name, config.enabled);
  }
  return getCaldavConfig(tenantId);
}

export function deleteCaldavConfig(tenantId) {
  return getDb().prepare('DELETE FROM caldav_config WHERE tenant_id = ?').run(tenantId);
}

// ── Clear All Local Data ──────────────────────────────────────────────────
// Removes all tenant-scoped data from SQLite. Tenant record is preserved
// (needed for session). Pod data is NOT affected.

export function clearAllLocalData(tenantId) {
  const d = getDb();
  const result = d.transaction(() => {
    const deleted = {};
    deleted.bookings = d.prepare('DELETE FROM bookings WHERE slug IN (SELECT booking_slug FROM tenants WHERE id = ?)').run(tenantId).changes;
    deleted.calendarEvents = d.prepare('DELETE FROM calendar_events WHERE tenant_id = ?').run(tenantId).changes;
    deleted.calendarFeedTokens = d.prepare('DELETE FROM calendar_feed_tokens WHERE tenant_id = ?').run(tenantId).changes;
    deleted.webhookDeliveries = d.prepare('DELETE FROM webhook_deliveries WHERE webhook_id IN (SELECT id FROM webhooks WHERE tenant_id = ?)').run(tenantId).changes;
    deleted.webhooks = d.prepare('DELETE FROM webhooks WHERE tenant_id = ?').run(tenantId).changes;
    deleted.branding = d.prepare('DELETE FROM branding WHERE tenant_id = ?').run(tenantId).changes;
    deleted.caldavConfig = d.prepare('DELETE FROM caldav_config WHERE tenant_id = ?').run(tenantId).changes;
    deleted.apiKeys = d.prepare('DELETE FROM api_keys WHERE tenant_id = ?').run(tenantId).changes;
    deleted.usageTracking = d.prepare('DELETE FROM usage_tracking WHERE tenant_id = ?').run(tenantId).changes;
    deleted.teamMembers = d.prepare('DELETE FROM team_members WHERE tenant_id = ?').run(tenantId).changes;
    return deleted;
  })();
  return result;
}

export function getLocalDataStats(tenantId) {
  const d = getDb();
  const slug = d.prepare('SELECT booking_slug FROM tenants WHERE id = ?').get(tenantId)?.booking_slug;
  return {
    bookings: d.prepare('SELECT COUNT(*) as c FROM bookings WHERE slug = ?').get(slug || '')?.c || 0,
    calendarEvents: d.prepare('SELECT COUNT(*) as c FROM calendar_events WHERE tenant_id = ?').get(tenantId)?.c || 0,
    webhooks: d.prepare('SELECT COUNT(*) as c FROM webhooks WHERE tenant_id = ?').get(tenantId)?.c || 0,
    branding: d.prepare('SELECT COUNT(*) as c FROM branding WHERE tenant_id = ?').get(tenantId)?.c || 0,
    caldavConfig: d.prepare('SELECT COUNT(*) as c FROM caldav_config WHERE tenant_id = ?').get(tenantId)?.c || 0,
    apiKeys: d.prepare('SELECT COUNT(*) as c FROM api_keys WHERE tenant_id = ? AND revoked_at IS NULL').get(tenantId)?.c || 0,
    teamMembers: d.prepare('SELECT COUNT(*) as c FROM team_members WHERE tenant_id = ?').get(tenantId)?.c || 0,
  };
}
