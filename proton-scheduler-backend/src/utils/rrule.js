/**
 * Minimal RRULE Expander
 *
 * Expands iCalendar RRULE strings into concrete occurrence dates within a
 * given date range.  Supports the subset of RFC 5545 needed by SolidScheduler:
 *
 *   FREQ   = DAILY | WEEKLY | MONTHLY | YEARLY
 *   INTERVAL, COUNT, UNTIL, BYDAY
 *
 * No external library — keeps the server bundle small.
 */

const DAY_MAP = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

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

/**
 * Add N intervals to a date based on frequency.
 * Returns a new Date (does not mutate).
 */
function addInterval(date, freq, n) {
  const d = new Date(date);
  switch (freq) {
    case 'DAILY':
      d.setDate(d.getDate() + n);
      break;
    case 'WEEKLY':
      d.setDate(d.getDate() + n * 7);
      break;
    case 'MONTHLY':
      d.setMonth(d.getMonth() + n);
      break;
    case 'YEARLY':
      d.setFullYear(d.getFullYear() + n);
      break;
  }
  return d;
}

/**
 * Expand an RRULE into concrete occurrence start dates within [rangeStart, rangeEnd].
 *
 * @param {string} rruleStr — The RRULE string
 * @param {Date|string} dtstart — The base event start date
 * @param {Date|string} rangeStart — Start of the query range
 * @param {Date|string} rangeEnd — End of the query range
 * @param {string[]} [excludedDates] — ISO date strings to skip (EXDATE)
 * @returns {Date[]} Array of occurrence start dates within range
 */
export function expandRRule(rruleStr, dtstart, rangeStart, rangeEnd, excludedDates = []) {
  const rule = parseRRule(rruleStr);
  if (!rule) return [new Date(dtstart)];

  const start = new Date(dtstart);
  const from = new Date(rangeStart);
  const to = new Date(rangeEnd);
  const excluded = new Set(excludedDates.map(d => new Date(d).toDateString()));

  // Safety limit — prevent runaway expansion
  const MAX_OCCURRENCES = 500;
  const occurrences = [];
  let count = 0;

  if (rule.freq === 'WEEKLY' && rule.byDay && rule.byDay.length > 0) {
    // WEEKLY + BYDAY: generate occurrences for each specified day of the week
    const targetDays = rule.byDay.map(d => DAY_MAP[d.toUpperCase()]).filter(d => d !== undefined);
    let weekStart = new Date(start);

    while (weekStart <= to && count < MAX_OCCURRENCES) {
      if (rule.count !== null && occurrences.length >= rule.count) break;
      if (rule.until && weekStart > rule.until) break;

      for (const dayNum of targetDays) {
        const occ = new Date(weekStart);
        const diff = dayNum - occ.getDay();
        occ.setDate(occ.getDate() + diff);
        // Keep original time
        occ.setHours(start.getHours(), start.getMinutes(), start.getSeconds());

        if (occ < start) continue;
        if (occ > to) continue;
        if (rule.until && occ > rule.until) continue;
        if (rule.count !== null && occurrences.length >= rule.count) break;
        if (excluded.has(occ.toDateString())) { count++; continue; }

        if (occ >= from) {
          occurrences.push(new Date(occ));
        }
        count++;
      }

      weekStart = addInterval(weekStart, 'WEEKLY', rule.interval);
    }
  } else {
    // Simple interval-based expansion
    let current = new Date(start);

    while (current <= to && count < MAX_OCCURRENCES) {
      if (rule.count !== null && count >= rule.count) break;
      if (rule.until && current > rule.until) break;

      if (current >= from && !excluded.has(current.toDateString())) {
        occurrences.push(new Date(current));
      }
      count++;
      current = addInterval(current, rule.freq, rule.interval);
    }
  }

  return occurrences;
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
