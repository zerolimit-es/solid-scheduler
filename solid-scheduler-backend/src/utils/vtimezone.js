/**
 * VTIMEZONE blocks for iCalendar output.
 *
 * A time written as `DTSTART;TZID=Europe/Paris:...` refers to a timezone the
 * file itself must define (RFC 5545 §3.6.5); a TZID with no VTIMEZONE is
 * invalid, and strict clients reject it or read the time as floating.
 *
 * The definition is derived from the runtime's own timezone data: one
 * observance for the offset in force at the start of the window, then one
 * per offset change (DST start or end) found in it.
 */

import { instantToNaive, isValidTimeZone, parseNaive } from './tz.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const cache = new Map();

/** Minutes ahead of UTC that `tz` is at an instant (given in ms). */
function offsetAt(ms, tz) {
  const wall = parseNaive(instantToNaive(new Date(ms), tz));
  const wallAsUTC = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return Math.round((wallAsUTC - Math.floor(ms / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

/** Wall-clock "YYYYMMDDTHHMMSS" of an instant at a fixed offset. */
function formatWall(ms, offsetMinutes) {
  return new Date(ms + offsetMinutes * MINUTE_MS).toISOString().slice(0, 19).replace(/[-:]/g, '');
}

/**
 * @param {string} tz - IANA timezone name
 * @param {{ fromYear?: number, toYear?: number }} [window] - Years to cover
 *   (default: last year through five years ahead)
 * @returns {string[]} iCalendar lines, or [] for an unknown timezone
 */
export function buildVTimezone(tz, window = {}) {
  if (!isValidTimeZone(tz)) return [];
  const thisYear = new Date().getUTCFullYear();
  const fromYear = window.fromYear ?? thisYear - 1;
  const toYear = window.toYear ?? thisYear + 5;
  const key = `${tz}|${fromYear}|${toYear}`;
  if (cache.has(key)) return cache.get(key);

  const start = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear + 1, 0, 1);
  const initial = offsetAt(start, tz);
  const lines = [
    'BEGIN:VTIMEZONE',
    `TZID:${tz}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    `TZOFFSETFROM:${formatOffset(initial)}`,
    `TZOFFSETTO:${formatOffset(initial)}`,
    'END:STANDARD',
  ];

  let previous = initial;
  for (let day = start + DAY_MS; day <= end; day += DAY_MS) {
    const current = offsetAt(day, tz);
    if (current === previous) continue;
    // The change happened in the last day: find its first minute
    let before = day - DAY_MS;
    let after = day;
    while (after - before > MINUTE_MS) {
      const mid = before + Math.floor((after - before) / 2 / MINUTE_MS) * MINUTE_MS;
      if (offsetAt(mid, tz) === previous) before = mid; else after = mid;
    }
    const kind = current > previous ? 'DAYLIGHT' : 'STANDARD';
    lines.push(
      `BEGIN:${kind}`,
      // Onset is given in the wall-clock time in force just before the change
      `DTSTART:${formatWall(after, previous)}`,
      `TZOFFSETFROM:${formatOffset(previous)}`,
      `TZOFFSETTO:${formatOffset(current)}`,
      `END:${kind}`,
    );
    previous = current;
  }

  lines.push('END:VTIMEZONE');
  cache.set(key, lines);
  return lines;
}
