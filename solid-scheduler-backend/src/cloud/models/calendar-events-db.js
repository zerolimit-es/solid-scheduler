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
import { addDays, naiveDiffMinutes } from '../../utils/tz.js';

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

  // Events overlapping [from, to), plus all recurring events
  stmts.getRange = db.prepare(
    `SELECT * FROM calendar_events
     WHERE tenant_id = ? AND (
       (recurrence IS NULL AND start_time < ? AND end_time > ?)
       OR recurrence IS NOT NULL
     )
     ORDER BY start_time ASC`
  );

  // Events that overlap [dayStart, nextDayStart), plus every recurring event
  // (expanded per date below). Naive "YYYY-MM-DD HH:MM" strings sort correctly.
  stmts.getByDate = db.prepare(
    `SELECT * FROM calendar_events
     WHERE tenant_id = ? AND (
       (recurrence IS NULL AND start_time < ? AND end_time > ?)
       OR recurrence IS NOT NULL
     )`
  );

  stmts.getByIcsUid = db.prepare(
    `SELECT * FROM calendar_events WHERE tenant_id = ? AND ics_uid = ?`
  );

  stmts.getUnsynced = db.prepare(
    `SELECT * FROM calendar_events WHERE tenant_id = ? AND synced_to_pod = 0 ORDER BY created_at ASC`
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
    event.color || '#6366F1',
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
 * Get calendar events that overlap a range ("YYYY-MM-DD HH:MM" bounds).
 * Also returns recurring events (regardless of range) for client-side expansion.
 */
export function getCalendarEventsInRange(tenantId, from, to) {
  return s().getRange.all(tenantId, to, from);
}

export function getCalendarEventByIcsUid(tenantId, icsUid) {
  return s().getByIcsUid.get(tenantId, icsUid) || null;
}

// ── Availability blocking ──

const DAY_MINUTES = 24 * 60;

/** Minutes from `date` 00:00 to a naive timestamp (may be <0 or >1440). */
function minutesFromDay(date, naive) {
  return naiveDiffMinutes(`${date} 00:00`, naive);
}

/**
 * Time blocked by calendar events on `date`, in the organizer's timezone.
 * Every event that overlaps the day counts, including all-day events and
 * events that started the day before; recurring events are expanded.
 *
 * @param {string} tenantId
 * @param {string} date 'YYYY-MM-DD'
 * @returns {Array<{ startMin: number, endMin: number }>} minutes since 00:00, clipped to the day
 */
export function getBlockedIntervals(tenantId, date) {
  if (!tenantId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return [];
  const dayStart = `${date} 00:00`;
  const nextDayStart = `${addDays(date, 1)} 00:00`;
  const rows = s().getByDate.all(tenantId, nextDayStart, dayStart);
  const intervals = [];

  const push = (startMin, endMin) => {
    const a = Math.max(0, startMin);
    const b = Math.min(DAY_MINUTES, endMin);
    if (b > a) intervals.push({ startMin: a, endMin: b });
  };

  for (const row of rows) {
    if (!row.recurrence) {
      push(minutesFromDay(date, row.start_time), minutesFromDay(date, row.end_time));
      continue;
    }
    const duration = naiveDiffMinutes(row.start_time, row.end_time);
    if (!(duration > 0)) continue;
    // Occurrences starting on this day or the day before (which may run into it)
    const occurrences = expandRRule(row.recurrence, row.start_time, `${addDays(date, -1)} 00:00`, `${date} 23:59`);
    const [, startTime] = row.start_time.split(' ');
    for (const occ of occurrences) {
      const occStart = `${formatDate(occ)} ${startTime}`;
      const startMin = minutesFromDay(date, occStart);
      push(startMin, startMin + duration);
    }
  }

  return intervals;
}

/** Whether [startMin, endMin) overlaps any blocked interval. */
export function isBlocked(intervals, startMin, endMin) {
  return intervals.some((b) => startMin < b.endMin && b.startMin < endMin);
}

// ── Pod sync helpers ──

/** Unsynced events for one account. No "all accounts" mode: events must only
 * ever be pushed to the Pod of the account they belong to. */
export function getUnsyncedCalendarEvents(tenantId) {
  if (!tenantId) throw new Error('getUnsyncedCalendarEvents requires a tenant ID');
  return s().getUnsynced.all(tenantId);
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

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
