/**
 * Migration 001 — Add booking_slug to tenants
 *
 * Problem: The public booking route (POST /api/public/:slug/book) needs to
 * look up which tenant owns a given booking page slug (e.g. "damien").
 * Currently it reads the availability record to extract an email, then
 * queries tenants by email — fragile if the two emails diverge.
 *
 * Fix: Store the slug directly on the tenant row so we can do a fast
 * indexed lookup: getTenantBySlug(slug).
 *
 * The column is UNIQUE because two tenants can't share a booking slug.
 * It's nullable because existing tenants won't have one until they
 * create/update their public booking page.
 */

export default {
  id: 1,
  name: 'add_booking_slug',

  up(db) {
    // SQLite doesn't support IF NOT EXISTS for ALTER TABLE, so we check
    // the schema first to make this safely re-runnable.
    const cols = db.pragma('table_info(tenants)');
    const hasBookingSlug = cols.some(c => c.name === 'booking_slug');

    if (!hasBookingSlug) {
      db.exec('ALTER TABLE tenants ADD COLUMN booking_slug TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_booking_slug ON tenants(booking_slug)');
    }
  },
};
