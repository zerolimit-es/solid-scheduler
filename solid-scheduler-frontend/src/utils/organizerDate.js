/**
 * Today's date in the organizer's timezone, as a local midnight Date.
 *
 * The booking calendar works in calendar days of the organizer's timezone
 * (that's what the server's slots are in). The visitor's own date can be a
 * day ahead of or behind it, which would grey out a day that still has
 * times, or offer one that has none left.
 *
 * @param {string} [timezone] - IANA timezone; the browser's when missing or unknown.
 */
export function organizerToday(timezone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date());
  }
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return new Date(get('year'), get('month') - 1, get('day'));
}
