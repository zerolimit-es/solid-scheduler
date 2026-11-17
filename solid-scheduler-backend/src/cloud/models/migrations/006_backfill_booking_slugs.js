/**
 * Migration 006 — Backfill booking slugs from WebID
 *
 * Existing tenants created before the auto-slug feature (PR #84) may still
 * have booking_slug = 'my-booking' (the old universal default) or NULL.
 * This migration derives a unique slug from each tenant's webid using the
 * same extractSlug() logic that new registrations now use.
 */

import { extractSlug } from '../../../utils/webid.js';

export default {
  id: 6,
  name: 'backfill_booking_slugs',

  up(db) {
    const rows = db
      .prepare(
        `SELECT id, webid, email, booking_slug
         FROM tenants
         WHERE booking_slug IS NULL
            OR booking_slug = 'my-booking'`
      )
      .all();

    if (rows.length === 0) return;

    const update = db.prepare(
      'UPDATE tenants SET booking_slug = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    const check = db.prepare(
      'SELECT 1 FROM tenants WHERE booking_slug = ?'
    );

    for (const row of rows) {
      let slug = extractSlug(row.webid || row.email || '');

      // Ensure uniqueness — append random suffix on collision
      if (check.get(slug)) {
        slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
      }

      update.run(slug, row.id);
      console.log(`[Migration 006] ${row.id} → ${slug}`);
    }
  },
};
