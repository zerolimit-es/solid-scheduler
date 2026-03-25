/**
 * Calendar Events — SQLite Model
 *
 * Follows the same dual-write pattern as bookings:
 *   SQLite (temporary inbox) → Solid Pod (source of truth)
 *
 * Prepared statements are lazily cached for performance.
 */

import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { getDb } from './database.js';
import { expandRRule } from '../../utils/rrule.js';

// ── Lazy prepared statement cache ──
const stmts = {};
function s() {
  if (stmts._ready) return stmts;
  const db = getDb();

  stmts.create = db.prepare(`
    INSERT INTO calendar_events
      (id, tenant_id, title, start_time, end_time, all_day, recurrence,
       color, category, notes, location, ics_uid, synced_to_pod)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);

  stmts.update = null; // dynamic — built per-call

  stmts.delete = db.prepare(
    `DELETE FROM calendar_events WHERE id = ? AND tenant_id = ?`
  );

  stmts.getOne = db.prepare(
    `SELECT * FROM calendar_events WHERE id = ? AND tenant_id = ?`
  );

  stmts.getRange = db.prepare(
    `SELECT * FROM calendar_events
     WHERE tenant_id = ? AND (
       (recurrence IS NULL AND start_time >= ? AND start_time <= ?)
       OR recurrence IS NOT NULL
     )
     ORDER BY start_time ASC`
  );

  stmts.getByDate = db.prepare(
    `SELECT * FROM calendar_events
     WHERE tenant_id = ? AND (
       (recurrence IS NULL AND start_time LIKE ?)
       OR recurrence IS NOT NULL
     )`
  );

  stmts.getByIcsUid = db.prepare(
    `SELECT * FROM calendar_events WHERE tenant_id = ? AND ics_uid = ?`
  );

  stmts.getUnsynced = db.prepare(
    `SELECT * FROM calendar_events WHERE tenant_id = ? AND synced_to_pod = 0 ORDER BY created_at ASC`
  );

  stmts.getUnsyncedAll = db.prepare(
    `SELECT * FROM calendar_events WHERE synced_to_pod = 0 ORDER BY created_at ASC`
  );

  stmts.markSynced = db.prepare(
    `UPDATE calendar_events SET synced_to_pod = 1, pod_url = ? WHERE id = ?`
  );

  stmts.countUnsynced = db.prepare(
    `SELECT COUNT(*) as c FROM calendar_events WHERE tenant_id = ? AND synced_to_pod = 0`
  );

  // Feed tokens
  stmts.createToken = db.prepare(
    `INSERT OR REPLACE INTO calendar_feed_tokens (token, tenant_id) VALUES (?, ?)`
  );

  stmts.getToken = db.prepare(
    `SELECT token FROM calendar_feed_tokens WHERE tenant_id = ?`
  );

  stmts.getTenantByToken = db.prepare(
    `SELECT tenant_id FROM calendar_feed_tokens WHERE token = ?`
  );

  stmts._ready = true;
  return stmts;
}

// ── Calendar Event CRUD ──

export function createCalendarEvent(tenantId, event) {
  const id = event.id || uuidv4();
  s().create.run(
    id, tenantId,
    event.title,
    event.startTime || event.start_time,
    event.endTime || event.end_time,
    event.allDay ? 1 : 0,
    event.recurrence || null,
    event.color || '#219EBC',
    event.category || 'default',
    event.notes || null,
    event.location || null,
    event.icsUid || event.ics_uid || null,
  );
  return { id, ...event, tenant_id: tenantId, synced_to_pod: 0 };
}

export function updateCalendarEvent(tenantId, eventId, updates) {
  const db = getDb();
  const allowed = [
    'title', 'start_time', 'end_time', 'all_day', 'recurrence',
    'color', 'category', 'notes', 'location',
  ];
  const sets = [];
  const vals = [];
  for (const [key, val] of Object.entries(updates)) {
    const col = key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`); // camelCase → snake_case
    if (allowed.includes(col)) {
      sets.push(`${col} = ?`);
      vals.push(col === 'all_day' ? (val ? 1 : 0) : val);
    }
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  // Reset sync flag so event gets re-synced to Pod
  sets.push('synced_to_pod = 0');
  vals.push(eventId, tenantId);
  db.prepare(
    `UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`
  ).run(...vals);
  return true;
}

export function deleteCalendarEvent(tenantId, eventId) {
  const result = s().delete.run(eventId, tenantId);
  return result.changes > 0;
}

export function getCalendarEvent(tenantId, eventId) {
  return s().getOne.get(eventId, tenantId) || null;
}

/**
 * Get calendar events in a date range.
 * Also returns recurring events (regardless of range) for client-side expansion.
 */
export function getCalendarEventsInRange(tenantId, from, to) {
  return s().getRange.all(tenantId, from, to);
}

export function getCalendarEventByIcsUid(tenantId, icsUid) {
  return s().getByIcsUid.get(tenantId, icsUid) || null;
}

// ── Availability blocking ──

/**
 * Get blocked time slots for a given date.
 * Mirrors getBookedSlots() signature from bookings-db.js.
 * Expands recurring events for the given date.
 *
 * @param {string} tenantId
 * @param {string} date — 'YYYY-MM-DD'
 * @returns {Array<{start_time: string, end_time: string}>}
 */
export function getBlockedSlots(tenantId, date) {
  const rows = s().getByDate.all(tenantId, `${date}%`);
  const slots = [];

  for (const row of rows) {
    if (!row.recurrence) {
      // Non-recurring: already filtered by date via LIKE
      slots.push({ start_time: row.start_time, end_time: row.end_time });
    } else {
      // Recurring: check if this date is an occurrence
      const rangeStart = `${date} 00:00`;
      const rangeEnd = `${date} 23:59`;
      const occurrences = expandRRule(
        row.recurrence,
        row.start_time,
        rangeStart,
        rangeEnd,
      );
      if (occurrences.length > 0) {
        // Calculate event duration to compute end times
        const [startDate, startTime] = row.start_time.split(' ');
        const [endDate, endTime] = row.end_time.split(' ');
        const startMin = timeToMinutes(startTime);
        const endMin = timeToMinutes(endTime);
        const durationMin = endMin - startMin;

        for (const occ of occurrences) {
          const occDate = formatDate(occ);
          const occStartTime = `${startTime.split(':')[0].padStart(2, '0')}:${startTime.split(':')[1]}`;
          const occEndMin = startMin + durationMin;
          const occEndTime = `${String(Math.floor(occEndMin / 60)).padStart(2, '0')}:${String(occEndMin % 60).padStart(2, '0')}`;
          slots.push({
            start_time: `${occDate} ${occStartTime}`,
            end_time: `${occDate} ${occEndTime}`,
          });
        }
      }
    }
  }

  return slots;
}

// ── Pod sync helpers ──

export function getUnsyncedCalendarEvents(tenantId) {
  if (tenantId) return s().getUnsynced.all(tenantId);
  return s().getUnsyncedAll.all();
}

export function markCalendarEventSynced(id, podUrl) {
  s().markSynced.run(podUrl, id);
}

export function getUnsyncedCalendarEventsCount(tenantId) {
  return s().countUnsynced.get(tenantId)?.c || 0;
}

// ── Feed token management ──

export function createFeedToken(tenantId) {
  const token = crypto.randomBytes(32).toString('hex');
  s().createToken.run(token, tenantId);
  return token;
}

export function getFeedToken(tenantId) {
  return s().getToken.get(tenantId)?.token || null;
}

export function getTenantByFeedToken(token) {
  return s().getTenantByToken.get(token)?.tenant_id || null;
}

// ── Cleanup ──

export function getCalendarCleanupStats(tenantId) {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM calendar_events WHERE tenant_id = ?').get(tenantId)?.c || 0;
  const synced = db.prepare('SELECT COUNT(*) as c FROM calendar_events WHERE tenant_id = ? AND synced_to_pod = 1').get(tenantId)?.c || 0;
  const unsynced = total - synced;

  const clearable = {};
  for (const [label, days] of [['day', 1], ['week', 7], ['month', 30], ['quarter', 90], ['year', 365]]) {
    clearable[label] = db.prepare(
      `SELECT COUNT(*) as c FROM calendar_events WHERE tenant_id = ? AND synced_to_pod = 1 AND start_time < date('now', '-' || ? || ' days')`
    ).get(tenantId, days)?.c || 0;
  }

  return { total, synced, unsynced, clearable };
}

export function clearSyncedCalendarEvents(tenantId, daysOld = 30) {
  const db = getDb();
  if (daysOld === 0) {
    const result = db.prepare('DELETE FROM calendar_events WHERE tenant_id = ? AND synced_to_pod = 1').run(tenantId);
    return { deleted: result.changes };
  }
  const result = db.prepare(
    `DELETE FROM calendar_events WHERE tenant_id = ? AND synced_to_pod = 1 AND start_time < date('now', '-' || ? || ' days')`
  ).run(tenantId, daysOld);
  return { deleted: result.changes };
}

// ── Helpers ──

function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
