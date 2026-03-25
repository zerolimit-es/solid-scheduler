/**
 * Migration 004: Add passkeys table for WebAuthn MFA
 */
export default {
  id: 4,
  name: 'add_passkeys',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        credential_id TEXT UNIQUE NOT NULL,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        device_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      );

      CREATE INDEX IF NOT EXISTS idx_passkeys_tenant ON passkeys(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_passkeys_credential ON passkeys(credential_id);
    `);
  },
};
