/**
 * RRULE helpers for calendar events ("blocked time").
 *
 * Parses and builds iCalendar RRULE strings, and expands them into concrete
 * occurrences within a date range. Supports the subset of RFC 5545 needed by
 * SolidScheduler:
 *
 *   FREQ   = DAILY | WEEKLY | MONTHLY | YEARLY
 *   INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH
 */

import {
  generateOccurrences,
  parseRRule as parseFullRRule,
} from '@zerolimit/packages/solid-pod-sync/core';

/**
 * Parse an RRULE string into a structured object.
 * @param {string} rrule — e.g. "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR"
 * @returns {Object}
 */
export function parseRRule(rrule) {
  if (!rrule) return null;
  const raw = rrule.replace(/^RRULE:/i, '');
  const parts = {};
  for (const segment of raw.split(';')) {
    const [key, val] = segment.split('=');
    if (key && val) parts[key.toUpperCase()] = val;
  }
  return {
    freq:     parts.FREQ || 'WEEKLY',
    interval: parseInt(parts.INTERVAL || '1', 10),
    count:    parts.COUNT ? parseInt(parts.COUNT, 10) : null,
    until:    parts.UNTIL ? parseUntil(parts.UNTIL) : null,
    byDay:    parts.BYDAY ? parts.BYDAY.split(',').map(d => d.trim()) : null,
  };
}

/**
 * Parse an UNTIL value (YYYYMMDD or YYYYMMDDTHHMMSSZ) into a Date.
 */
function parseUntil(val) {
  if (val.length === 8) {
    return new Date(Date.UTC(
      parseInt(val.slice(0, 4), 10),
      parseInt(val.slice(4, 6), 10) - 1,
      parseInt(val.slice(6, 8), 10),
      23, 59, 59,
    ));
  }
  // Full datetime: YYYYMMDDTHHMMSSZ
  return new Date(
    val.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/, '$1-$2-$3T$4:$5:$6Z')
  );
}

// Stored times are naive local times ("YYYY-MM-DD HH:MM"): `new Date()` reads
// them in the server's timezone. Recurrence is worked out on wall-clock
// dates (UTC fields holding the local date and time), so the result is the
// same local time on every occurrence whatever the server's timezone.
const localToWall = (d) => new Date(Date.UTC(
  d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
const wallToLocal = (w) => new Date(
  w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds());

/**
 * Expand an RRULE into the occurrences that start within a range.
 *
 * Uses the same engine as recurring bookings (@zerolimit/solid-pod-sync),
 * so COUNT is counted from the first occurrence, days that do not exist are
 * skipped, and a series keeps producing occurrences however long ago it
 * started.
 *
 * @param {string} rruleStr - e.g. "FREQ=WEEKLY;BYDAY=MO,WE"
 * @param {string|Date} dtstart - First occurrence (naive local time)
 * @param {string|Date} rangeStart
 * @param {string|Date} rangeEnd
 * @param {Array<string|Date>} [excludedDates] - Occurrences to leave out
 * @returns {Date[]} Occurrence start times, as local Dates
 */
export function expandRRule(rruleStr, dtstart, rangeStart, rangeEnd, excludedDates = []) {
  const rule = parseRRule(rruleStr);
  if (!rule) return [new Date(dtstart)];

  const fullRule = parseFullRRule(rruleStr) || {};
  return generateOccurrences(
    localToWall(new Date(dtstart)),
    {
      ...fullRule,
      frequency: rule.freq,
      interval: rule.interval,
      count: rule.count,
      // parseUntil() gives UNTIL as UTC fields, which is wall time here
      until: rule.until,
      byDay: rule.byDay,
    },
    {
      rangeStart: localToWall(new Date(rangeStart)),
      rangeEnd: localToWall(new Date(rangeEnd)),
      excludedDates: excludedDates.map((d) => localToWall(new Date(d))),
      maxOccurrences: 5000,
    },
  ).map(wallToLocal);
}

/**
 * Build an RRULE string from a structured object.
 * @param {Object} rule — { freq, interval, count, until, byDay }
 * @returns {string} — e.g. "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR"
 */
export function buildRRule(rule) {
  const parts = [`FREQ=${rule.freq || rule.frequency || 'WEEKLY'}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count) parts.push(`COUNT=${rule.count}`);
  if (rule.until) {
    const d = new Date(rule.until);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    parts.push(`UNTIL=${y}${m}${day}T235959Z`);
  }
  if (rule.byDay && rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  return parts.join(';');
}
