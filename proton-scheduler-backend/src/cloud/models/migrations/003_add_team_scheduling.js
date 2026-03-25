/**
 * Migration 003 — Add team scheduling tables
 *
 * Creates:
 *   - tenants.scheduling_mode column ('none'|'round_robin'|'collective'|'managed')
 *   - team_members table (per-tenant team with email-only or Solid Pod members)
 *   - team_member_availability table (per-member availability JSON blob)
 *   - bookings.assigned_member_* columns for team assignment tracking
 */

export default {
  id: 3,
  name: 'add_team_scheduling',

  up(db) {
    // 1. Add scheduling_mode to tenants
    const cols = db.pragma('table_info(tenants)');
    if (!cols.some(c => c.name === 'scheduling_mode')) {
      db.exec("ALTER TABLE tenants ADD COLUMN scheduling_mode TEXT NOT NULL DEFAULT 'none'");
    }

    // 2. team_members table
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_members (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        webid TEXT,
        solid_pod_url TEXT,
        round_robin_weight INTEGER NOT NULL DEFAULT 1,
        round_robin_count INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, email)
      );
      CREATE INDEX IF NOT EXISTS idx_team_members_tenant ON team_members(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_team_members_email ON team_members(email);
    `);

    // 3. team_member_availability table
    db.exec(`
      CREATE TABLE IF NOT EXISTS team_member_availability (
        member_id TEXT PRIMARY KEY REFERENCES team_members(id),
        data TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. Assigned member columns on bookings are added in initBookingsTable()
    //    (bookings-db.js) because the bookings table is created lazily, not
    //    during initSchema. This follows the same pattern used for
    //    synced_to_pod and pod_url columns.
  },
};
