// ---------------------------------------------------------------------------
// Team scheduling — database model
//
// Follows the prepared-statement caching pattern from database.js.
// Provides CRUD for team members, per-member availability, scheduling mode,
// round-robin assignment, and collective availability calculation.
// ---------------------------------------------------------------------------

import { getDb } from './database.js';
import crypto from 'crypto';

const teamStmts = {};

function getTeamStmts() {
  if (!teamStmts.create) {
    const d = getDb();
    teamStmts.create = d.prepare(
      `INSERT INTO team_members (id, tenant_id, email, name, role, webid, solid_pod_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    teamStmts.getById = d.prepare('SELECT * FROM team_members WHERE id = ?');
    teamStmts.getByTenantAndEmail = d.prepare(
      'SELECT * FROM team_members WHERE tenant_id = ? AND email = ?'
    );
    teamStmts.listByTenant = d.prepare(
      'SELECT * FROM team_members WHERE tenant_id = ? ORDER BY created_at ASC'
    );
    teamStmts.listActiveByTenant = d.prepare(
      'SELECT * FROM team_members WHERE tenant_id = ? AND active = 1 ORDER BY created_at ASC'
    );
    teamStmts.countByTenant = d.prepare(
      'SELECT COUNT(*) as count FROM team_members WHERE tenant_id = ?'
    );
    teamStmts.update = d.prepare(
      `UPDATE team_members SET name = ?, role = ?, webid = ?, solid_pod_url = ?,
       round_robin_weight = ?, active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND tenant_id = ?`
    );
    teamStmts.delete = d.prepare(
      'DELETE FROM team_members WHERE id = ? AND tenant_id = ?'
    );
    teamStmts.incrementRoundRobin = d.prepare(
      'UPDATE team_members SET round_robin_count = round_robin_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    teamStmts.resetRoundRobinCounts = d.prepare(
      'UPDATE team_members SET round_robin_count = 0, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?'
    );
    // Scheduling mode on tenant
    teamStmts.setSchedulingMode = d.prepare(
      'UPDATE tenants SET scheduling_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    // Per-member availability
    teamStmts.getAvailability = d.prepare(
      'SELECT data FROM team_member_availability WHERE member_id = ?'
    );
    teamStmts.upsertAvailability = d.prepare(
      `INSERT INTO team_member_availability (member_id, data, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(member_id)
       DO UPDATE SET data = ?, updated_at = CURRENT_TIMESTAMP`
    );
    teamStmts.deleteAvailability = d.prepare(
      'DELETE FROM team_member_availability WHERE member_id = ?'
    );
  }
  return teamStmts;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function addTeamMember(tenantId, { email, name, role, webid, solidPodUrl }) {
  const id = crypto.randomUUID();
  const stmts = getTeamStmts();
  stmts.create.run(id, tenantId, email, name, role || 'member', webid || null, solidPodUrl || null);
  return stmts.getById.get(id);
}

export function getTeamMember(id) {
  return getTeamStmts().getById.get(id);
}

export function getTeamMemberByEmail(tenantId, email) {
  return getTeamStmts().getByTenantAndEmail.get(tenantId, email);
}

export function listTeamMembers(tenantId) {
  return getTeamStmts().listByTenant.all(tenantId);
}

export function listActiveTeamMembers(tenantId) {
  return getTeamStmts().listActiveByTenant.all(tenantId);
}

export function countTeamMembers(tenantId) {
  return getTeamStmts().countByTenant.get(tenantId).count;
}

export function updateTeamMember(id, tenantId, updates) {
  const existing = getTeamStmts().getById.get(id);
  if (!existing || existing.tenant_id !== tenantId) return null;
  getTeamStmts().update.run(
    updates.name ?? existing.name,
    updates.role ?? existing.role,
    updates.webid ?? existing.webid,
    updates.solidPodUrl ?? existing.solid_pod_url,
    updates.roundRobinWeight ?? existing.round_robin_weight,
    updates.active !== undefined ? (updates.active ? 1 : 0) : existing.active,
    id,
    tenantId,
  );
  return getTeamStmts().getById.get(id);
}

export function removeTeamMember(id, tenantId) {
  const stmts = getTeamStmts();
  stmts.deleteAvailability.run(id);
  const result = stmts.delete.run(id, tenantId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Scheduling mode
// ---------------------------------------------------------------------------

const VALID_MODES = ['none', 'round_robin', 'collective', 'managed'];

export function setSchedulingMode(tenantId, mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid scheduling mode: ${mode}`);
  }
  return getTeamStmts().setSchedulingMode.run(mode, tenantId);
}

// ---------------------------------------------------------------------------
// Round-robin
// ---------------------------------------------------------------------------

export function incrementRoundRobinCount(memberId) {
  return getTeamStmts().incrementRoundRobin.run(memberId);
}

export function resetRoundRobinCounts(tenantId) {
  return getTeamStmts().resetRoundRobinCounts.run(tenantId);
}

/**
 * Pick the next team member for a round-robin booking.
 * Uses weighted round-robin: member with lowest (count / weight) ratio wins.
 * On tie, the member created first is chosen (stable — listActiveByTenant is ASC).
 */
export function pickRoundRobinMember(tenantId) {
  const members = listActiveTeamMembers(tenantId);
  if (members.length === 0) return null;

  let best = members[0];
  let bestRatio = best.round_robin_count / best.round_robin_weight;

  for (let i = 1; i < members.length; i++) {
    const ratio = members[i].round_robin_count / members[i].round_robin_weight;
    if (ratio < bestRatio) {
      best = members[i];
      bestRatio = ratio;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Per-member availability
// ---------------------------------------------------------------------------

export function getMemberAvailability(memberId) {
  const row = getTeamStmts().getAvailability.get(memberId);
  return row ? JSON.parse(row.data) : null;
}

export function saveMemberAvailability(memberId, data) {
  const json = JSON.stringify(data);
  getTeamStmts().upsertAvailability.run(memberId, json, json);
}

// ---------------------------------------------------------------------------
// Collective availability
// ---------------------------------------------------------------------------

/**
 * Calculate collective availability for all active team members on a given date.
 * Returns time slots where ALL members are available (intersection).
 *
 * @param {string} tenantId
 * @param {string} date      - YYYY-MM-DD
 * @param {string} slug      - booking slug (for fetching booked slots)
 * @param {number} duration  - slot duration in minutes (default 30)
 * @returns {Array<{time: string, displayTime: string}>}
 */
export function getCollectiveSlots(tenantId, date, slug, duration = 30) {
  const members = listActiveTeamMembers(tenantId);
  if (members.length === 0) return [];

  const [year, month, day] = date.split('-').map(Number);
  const dateObj = new Date(year, month - 1, day);
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const dayName = dayNames[dateObj.getDay()];

  // Build set of minutes-of-day where ALL members are available (intersection)
  let commonMinutes = null;

  for (const member of members) {
    const avail = getMemberAvailability(member.id);
    if (!avail) return []; // member has no availability → no collective slots

    let daySettings = null;
    if (avail.days && avail.days[dayName]) daySettings = avail.days[dayName];
    else if (avail[dayName]) daySettings = avail[dayName];

    if (!daySettings || !daySettings.enabled) return []; // member unavailable this day

    const [startH, startM] = (daySettings.start || '09:00').split(':').map(Number);
    const [endH, endM] = (daySettings.end || '17:00').split(':').map(Number);
    const memberStart = startH * 60 + startM;
    const memberEnd = endH * 60 + endM;

    const memberMinutes = new Set();
    for (let m = memberStart; m < memberEnd; m++) {
      memberMinutes.add(m);
    }

    if (commonMinutes === null) {
      commonMinutes = memberMinutes;
    } else {
      for (const m of commonMinutes) {
        if (!memberMinutes.has(m)) commonMinutes.delete(m);
      }
    }
  }

  if (!commonMinutes || commonMinutes.size === 0) return [];

  // Convert common minutes to duration-length slots
  const sortedMinutes = [...commonMinutes].sort((a, b) => a - b);
  const slots = [];

  for (const slotStart of sortedMinutes) {
    // Check if a full duration window exists starting here
    let valid = true;
    for (let m = slotStart; m < slotStart + duration; m++) {
      if (!commonMinutes.has(m)) { valid = false; break; }
    }
    if (!valid) continue;

    // Only emit slots on duration boundaries from the earliest common start
    if ((slotStart - sortedMinutes[0]) % duration !== 0) continue;

    const hour = Math.floor(slotStart / 60);
    const min = slotStart % 60;
    const time = `${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
    const h12 = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    const ampm = hour >= 12 ? 'PM' : 'AM';
    slots.push({
      time,
      displayTime: `${h12}:${min.toString().padStart(2, '0')} ${ampm}`,
    });
  }

  return slots;
}
