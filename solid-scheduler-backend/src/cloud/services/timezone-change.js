/**
 * Moving an account to another timezone.
 *
 * Bookings and blocked time are stored as wall-clock times ("YYYY-MM-DD
 * HH:MM") in the account's timezone. When the timezone changes, every stored
 * time is rewritten so it still names the same moment: a 10:00 meeting in
 * Paris becomes 18:00 in Tokyo, not 10:00 in Tokyo. The Pod copies hold
 * absolute times already, so they stay as they are and agree again.
 *
 * Repeating entries keep their first occurrence's moment. When that moves to
 * another calendar day, the days named in the rule (BYDAY, BYMONTHDAY) and
 * the cancelled dates move with it, and the Pod copy's rule is rewritten at
 * the next sync. All-day blocked time is a set of dates, not moments, and is
 * left alone.
 */

import { getDb } from '../models/database.js';
import { instantToNaive, naiveToInstant, isValidTimeZone } from '../../utils/tz.js';

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** A wall-clock time in `from` as the same moment's wall-clock time in `to`. */
export function convertNaive(naive, from, to) {
  const instant = naiveToInstant(naive, from);
  return instant ? instantToNaive(instant, to) : naive;
}

/** Whole days from date `a` to date `b` ("YYYY-MM-DD"). */
function dayDelta(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * Move the days a recurrence rule names by `delta` days. BYDAY codes keep
 * their ordinal ("1MO" → "1TU"); BYMONTHDAY values that would leave 1..31
 * make the rule stay as it is.
 */
export function shiftRuleDays(rule, delta) {
  if (!rule || !delta) return rule;
  const parts = rule.split(';');
  const shifted = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key?.toUpperCase() === 'BYDAY' && value) {
      const days = value.split(',').map((code) => {
        const m = /^([+-]?\d*)([A-Z]{2})$/i.exec(code.trim());
        if (!m) return code;
        const index = WEEKDAYS.indexOf(m[2].toUpperCase());
        if (index < 0) return code;
        return `${m[1]}${WEEKDAYS[(((index + delta) % 7) + 7) % 7]}`;
      });
      shifted.push(`${key}=${days.join(',')}`);
    } else if (key?.toUpperCase() === 'BYMONTHDAY' && value) {
      const days = value.split(',').map((d) => Number(d) + delta);
      if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 31)) return rule;
      shifted.push(`${key}=${days.join(',')}`);
    } else {
      shifted.push(part);
    }
  }
  return shifted.join(';');
}

/** The new start, end, rule and cancelled dates for one stored entry. */
function convertRow(row, from, to) {
  const start = convertNaive(row.start_time, from, to);
  const end = convertNaive(row.end_time, from, to);
  const delta = dayDelta(row.start_time.slice(0, 10), start.slice(0, 10));
  const recurrence = row.recurrence ? shiftRuleDays(row.recurrence, delta) : row.recurrence;
  let excluded = row.excluded_dates;
  if (excluded) {
    const time = row.start_time.slice(11);
    excluded = String(excluded).split(',').map((d) => d.trim()).filter(Boolean)
      .map((d) => convertNaive(`${d} ${time}`, from, to).slice(0, 10))
      .join(',');
  }
  return { start, end, recurrence, excluded };
}

/**
 * Rewrite an account's stored times from timezone `from` to `to`. Call inside
 * the same transaction that saves the new timezone.
 *
 * @param {{ slug?: string|null, tenantId?: string|null, from: string, to: string }} options
 * @returns {{ bookings: number, calendarEvents: number }}
 */
export function convertAccountTimes({ slug, tenantId, from, to }) {
  const counts = { bookings: 0, calendarEvents: 0 };
  if (!isValidTimeZone(from) || !isValidTimeZone(to) || from === to) return counts;
  const db = getDb();

  if (slug) {
    // The Pod copy holds absolute times, which stay right, but a repeat rule
    // that moved to other days must be rewritten there too (pod_rule_pending)
    const update = db.prepare(
      `UPDATE bookings SET start_time = ?, end_time = ?, recurrence = ?, excluded_dates = ?,
         pod_rule_pending = CASE WHEN ? THEN 1 ELSE pod_rule_pending END
       WHERE id = ?`
    );
    for (const row of db.prepare(
      'SELECT id, start_time, end_time, recurrence, excluded_dates, pod_url FROM bookings WHERE slug = ?'
    ).all(slug)) {
      const next = convertRow(row, from, to);
      const ruleMoved = !!row.pod_url && !!row.recurrence && next.recurrence !== row.recurrence;
      update.run(next.start, next.end, next.recurrence, next.excluded, ruleMoved ? 1 : 0, row.id);
      counts.bookings++;
    }
  }

  if (tenantId) {
    // A repeat rule that moved to other days: mark the event unsynced, and
    // the next sync replaces its Pod copy
    const update = db.prepare(
      `UPDATE calendar_events SET start_time = ?, end_time = ?, recurrence = ?,
         synced_to_pod = CASE WHEN ? THEN 0 ELSE synced_to_pod END
       WHERE id = ? AND tenant_id = ?`
    );
    for (const row of db.prepare(
      'SELECT id, start_time, end_time, recurrence FROM calendar_events WHERE tenant_id = ? AND all_day = 0'
    ).all(tenantId)) {
      const next = convertRow(row, from, to);
      const ruleMoved = !!row.recurrence && next.recurrence !== row.recurrence;
      update.run(next.start, next.end, next.recurrence, ruleMoved ? 1 : 0, row.id, tenantId);
      counts.calendarEvents++;
    }
  }

  return counts;
}
