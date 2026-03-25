/**
 * Migration 008: Add calendar_events and calendar_feed_tokens tables
 *
 * Introduces the built-in calendar feature (Pro+).
 * calendar_events stores personal events that block availability.
 * calendar_feed_tokens stores per-tenant ICS feed tokens for
 * subscribable calendar URLs (e.g. Proton Calendar).
 *
 * Events follow the same dual-write pattern as bookings:
 * SQLite as temporary inbox → synced to Solid Pod as source of truth.
 */
export default {
  id: 8,
  name: 'add_calendar_events',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        title       TEXT NOT NULL,
        start_time  TEXT NOT NULL,
        end_time    TEXT NOT NULL,
        all_day     INTEGER NOT NULL DEFAULT 0,
        recurrence  TEXT,
        color       TEXT DEFAULT '#219EBC',
        category    TEXT DEFAULT 'default',
        notes       TEXT,
        location    TEXT,
        ics_uid     TEXT,
        synced_to_pod INTEGER DEFAULT 0,
        pod_url     TEXT,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_cal_events_tenant
        ON calendar_events(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_cal_events_tenant_range
        ON calendar_events(tenant_id, start_time, end_time);
      CREATE INDEX IF NOT EXISTS idx_cal_events_synced
        ON calendar_events(synced_to_pod);
    `);

    // Conditional unique index on ics_uid (only when non-null) for import dedup
    // SQLite doesn't support WHERE on CREATE UNIQUE INDEX in all versions,
    // so we use a regular unique index — NULL values are always considered distinct.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_events_ics_uid
        ON calendar_events(tenant_id, ics_uid);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_feed_tokens (
        token     TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_token_tenant
        ON calendar_feed_tokens(tenant_id);
    `);
  },
};
