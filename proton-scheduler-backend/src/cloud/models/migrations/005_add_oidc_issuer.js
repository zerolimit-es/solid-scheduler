/**
 * Migration 005: Add oidc_issuer column to tenants
 *
 * Stores which Solid identity provider each tenant logged in with,
 * so reconnect/sync can redirect to the correct IDP instead of
 * defaulting to Inrupt PodSpaces.
 */
export default {
  id: 5,
  name: 'add_oidc_issuer',
  up(db) {
    db.exec(`ALTER TABLE tenants ADD COLUMN oidc_issuer TEXT`);
  },
};
