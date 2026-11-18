/**
 * Migration 010: a log of confirmation emails sent, per account.
 *
 * Saving a notification email sends a confirmation link to it. Without an
 * overall limit an account could save one address after another and have
 * the server email each of them. The log lets the server cap how many
 * confirmation emails an account can trigger (see email-verification-db.js).
 */
export default {
  id: 10,
  name: 'add_email_verification_sends',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS email_verification_sends (
        tenant_id TEXT NOT NULL,
        sent_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_email_verification_sends ON email_verification_sends(tenant_id, sent_at);
    `);
  },
};
