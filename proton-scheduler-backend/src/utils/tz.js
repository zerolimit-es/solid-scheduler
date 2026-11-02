/**
 * Timezone helpers for "naive local" timestamps.
 *
 * Bookings and calendar events are stored as "YYYY-MM-DD HH:MM" in the
 * organizer's timezone (their availability timezone). These helpers convert
 * between that form and absolute instants without depending on the server's
 * own timezone.
 */

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

/** True for a valid IANA timezone name. */
export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Absolute instant → "YYYY-MM-DD HH:MM" in `tz`. */
export function instantToNaive(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/** Wall-clock time in `tz` → absolute instant (Date). */
export function zonedToInstant(year, month, day, hour, minute, tz) {
  // Guess the instant as if the wall time were UTC, then correct by the
  // zone's offset at that instant. Two passes settle DST transitions.
  const wallAsUTC = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallAsUTC;
  for (let i = 0; i < 2; i++) {
    const shown = instantToNaive(new Date(instant), tz);
    const m = NAIVE.exec(shown);
    const shownAsUTC = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    instant += wallAsUTC - shownAsUTC;
  }
  return new Date(instant);
}

/**
 * Parse "YYYY-MM-DD HH:MM" (or with a "T") into its parts, or null if it
 * isn't one or isn't a real calendar date and time.
 */
export function parseNaive(value) {
  const m = NAIVE.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const check = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d
    || h > 23 || mi > 59) {
    return null;
  }
  return { year: y, month: mo, day: d, hour: h, minute: mi, text: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` };
}

/** "YYYY-MM-DD" + n days, calendar arithmetic only. */
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Minutes between two naive timestamps (b − a), ignoring DST. */
export function naiveDiffMinutes(a, b) {
  const pa = parseNaive(a);
  const pb = parseNaive(b);
  if (!pa || !pb) return NaN;
  return (Date.UTC(pb.year, pb.month - 1, pb.day, pb.hour, pb.minute)
    - Date.UTC(pa.year, pa.month - 1, pa.day, pa.hour, pa.minute)) / 60000;
}
