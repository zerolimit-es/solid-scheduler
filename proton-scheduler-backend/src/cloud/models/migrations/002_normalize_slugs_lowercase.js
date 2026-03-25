/**
 * Migration 002 — Normalize all slugs to lowercase
 *
 * Problem: Slugs were stored with mixed case (e.g. "damien_B91ab" and
 * "damien_b91ab") because there was no normalization. This caused:
 * - Duplicate entries in the cleanup stats breakdown
 * - Bookings "stuck" as unsynced because slug didn't match
 * - Case-sensitive lookups failing silently
 *
 * Fix: Lowercase all slugs in bookings, availability, and tenants tables.
 */

export default {
  id: 2,
  name: 'normalize_slugs_lowercase',

  up(db) {
    // Helper: check if a table exists before querying it
    const tableExists = (name) => {
      const row = db.prepare(
        "SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name=?"
      ).get(name);
      return row.c > 0;
    };

    // 1. Normalize bookings.slug
    if (tableExists('bookings')) {
      try {
        const rows = db.prepare(
          "SELECT DISTINCT slug FROM bookings WHERE slug != lower(slug)"
        ).all();
        if (rows.length > 0) {
          const update = db.prepare('UPDATE bookings SET slug = lower(slug) WHERE slug = ?');
          for (const row of rows) update.run(row.slug);
          console.log(`[Migration 002] Normalized ${rows.length} booking slug(s) to lowercase`);
        }
      } catch (e) {
        console.warn('[Migration 002] Could not normalize bookings slugs:', e.message);
      }
    }

    // 2. Normalize availability.slug
    if (tableExists('availability')) {
      try {
        const rows = db.prepare(
          "SELECT DISTINCT slug FROM availability WHERE slug IS NOT NULL AND slug != lower(slug)"
        ).all();
        if (rows.length > 0) {
          const update = db.prepare('UPDATE availability SET slug = lower(slug) WHERE slug = ?');
          for (const row of rows) update.run(row.slug);
          console.log(`[Migration 002] Normalized ${rows.length} availability slug(s) to lowercase`);
        }
      } catch {
        // availability table may not have slug column
      }
    }

    // 3. Normalize tenants.booking_slug
    if (tableExists('tenants')) {
      try {
        const rows = db.prepare(
          "SELECT id, booking_slug FROM tenants WHERE booking_slug IS NOT NULL AND booking_slug != lower(booking_slug)"
        ).all();
        if (rows.length > 0) {
          const update = db.prepare('UPDATE tenants SET booking_slug = lower(booking_slug) WHERE id = ?');
          for (const row of rows) update.run(row.id);
          console.log(`[Migration 002] Normalized ${rows.length} tenant slug(s) to lowercase`);
        }
      } catch {
        // booking_slug column may not exist yet
      }
    }
  },
};
