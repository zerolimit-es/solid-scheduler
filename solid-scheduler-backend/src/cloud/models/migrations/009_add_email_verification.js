/**
 * Migration 009: confirmed notification emails.
 *
 * An account's notification email only receives booking emails once its
 * owner has confirmed it by clicking a link sent there. Without this, any
 * account could enter someone else's address and have the server email it.
 *
 * - email_verifications: one row per account, the address that is confirmed
 *   (verified_email) and the one waiting for confirmation (pending_email,
 *   with the hash of its link token and when it expires).
 * - Addresses accounts saved before this existed count as confirmed, so
 *   existing setups keep receiving notifications.
 */
export default {
  id: 9,
  name: 'add_email_verification',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        tenant_id      TEXT PRIMARY KEY,
        verified_email TEXT,
        pending_email  TEXT,
        token_hash     TEXT,
        expires_at     INTEGER,
        sent_at        INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications(token_hash);
    `);

    // The availability table is created on first use; an install without
    // it has no saved emails to keep
    const hasAvailability = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'availability'"
    ).get();
    if (!hasAvailability) return;

    const rows = db.prepare(
      'SELECT t.id AS tenant_id, a.data AS data FROM tenants t JOIN availability a ON a.slug = t.booking_slug'
    ).all();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO email_verifications (tenant_id, verified_email) VALUES (?, ?)'
    );
    for (const row of rows) {
      let data;
      try { data = JSON.parse(row.data); } catch { continue; }
      const email = String(data?.organizerEmail || data?.email || '').trim().toLowerCase();
      if (email) insert.run(row.tenant_id, email);
    }
  },
};
