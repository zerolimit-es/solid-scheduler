/**
 * Migration Runner
 *
 * Tracks which migrations have been applied in a `_migrations` table and
 * runs any that are still pending, in order.
 *
 * Each migration file exports:
 *   - id       {number}   Unique sequential number (001, 002, …)
 *   - name     {string}   Human-readable label
 *   - up(db)   {function} Receives the better-sqlite3 instance
 *
 * Usage (called once at startup from database.js):
 *   import { runMigrations } from './migrations/runner.js';
 *   runMigrations(db);
 */

import migration001 from './001_add_booking_slug.js';
import migration002 from './002_normalize_slugs_lowercase.js';
import migration003 from './003_add_team_scheduling.js';
import migration004 from './004_add_passkeys.js';
import migration005 from './005_add_oidc_issuer.js';
import migration006 from './006_backfill_booking_slugs.js';
import migration007 from './007_add_branding_light_variant.js';
import migration008 from './008_add_calendar_events.js';

const ALL_MIGRATIONS = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
];

export function runMigrations(db) {
  // Ensure the tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id   INTEGER PRIMARY KEY,
      name TEXT    NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map(r => r.id)
  );

  const pending = ALL_MIGRATIONS.filter(m => !applied.has(m.id));

  if (pending.length === 0) return;

  console.log(`[Migrations] ${pending.length} pending migration(s)`);

  const insert = db.prepare(
    'INSERT INTO _migrations (id, name) VALUES (?, ?)'
  );

  for (const migration of pending) {
    try {
      // Run each migration inside its own transaction so a failure
      // doesn't leave the tracking table out of sync.
      db.transaction(() => {
        migration.up(db);
        insert.run(migration.id, migration.name);
      })();
      console.log(`[Migrations] ✔ ${migration.id} — ${migration.name}`);
    } catch (err) {
      console.error(`[Migrations] ✗ ${migration.id} — ${migration.name}:`, err.message);
      throw err; // Halt startup — don't run later migrations on a broken schema
    }
  }
}
