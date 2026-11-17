import { getDb } from './database.js';
import { expandRRule } from '../../utils/rrule.js';
import { addDays, naiveDiffMinutes, parseNaive } from '../../utils/tz.js';

export function initBookingsTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      organizer_name TEXT,
      organizer_email TEXT,
      attendee_name TEXT NOT NULL,
      attendee_email TEXT NOT NULL,
      notes TEXT,
      location TEXT DEFAULT 'Video Call',
      status TEXT DEFAULT 'confirmed',
      ics_content TEXT,
      synced_to_pod INTEGER DEFAULT 0,
      pod_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_slug ON bookings(slug);
    CREATE INDEX IF NOT EXISTS idx_bookings_start ON bookings(start_time);
    CREATE INDEX IF NOT EXISTS idx_bookings_synced ON bookings(synced_to_pod);
  `);

  // Add synced_to_pod column if missing (upgrade path)
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN synced_to_pod INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN pod_url TEXT`);
  } catch (e) {
    // Column already exists
  }
  // Team scheduling: assigned member columns (added by team scheduling feature)
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN assigned_member_id TEXT`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN assigned_member_name TEXT`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN assigned_member_email TEXT`);
  } catch (e) {
    // Column already exists
  }
  // Recurring bookings: the RRULE the booking repeats by, and the local dates
  // ("YYYY-MM-DD", comma-separated) of occurrences cancelled on their own.
  // Every occurrence takes its slot on the public booking page.
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN recurrence TEXT`);
  } catch (e) {
    // Column already exists
  }
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN excluded_dates TEXT`);
  } catch (e) {
    // Column already exists
  }
  // A booking already in the Pod that was cancelled here while its owner was
  // signed out: the Pod copy is cancelled at the next sync.
  try {
    db.exec(`ALTER TABLE bookings ADD COLUMN pod_cancel_pending INTEGER DEFAULT 0`);
  } catch (e) {
    // Column already exists
  }
}

export function createBooking(booking) {
  const db = getDb();
  db.prepare(`
    INSERT INTO bookings (id, slug, title, start_time, end_time, organizer_name, organizer_email,
      attendee_name, attendee_email, notes, location, status, ics_content, synced_to_pod,
      recurrence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    booking.id, booking.slug, booking.title,
    booking.start, booking.end,
    booking.organizerName || '', booking.organizerEmail || '',
    booking.attendeeName, booking.attendeeEmail,
    booking.notes || '', booking.location || 'Video Call',
    'confirmed', booking.icsContent || '',
    booking.recurrence || null,
  );
  return booking;
}

/**
 * Record a booking that was written straight to the owner's Pod, so the
 * public booking page and the calendar feed (which read this table, not the
 * Pod) know the time is taken. Stored as already synced.
 *
 * @returns {boolean} false when a row with this ID already exists
 */
export function recordPodBooking(booking) {
  const db = getDb();
  const result = db.prepare(`
    INSERT OR IGNORE INTO bookings (id, slug, title, start_time, end_time, organizer_name, organizer_email,
      attendee_name, attendee_email, notes, location, status, ics_content, synced_to_pod, pod_url, recurrence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 1, ?, ?)
  `).run(
    booking.id, booking.slug, booking.title,
    booking.start, booking.end,
    booking.organizerName || '', booking.organizerEmail || '',
    booking.attendeeName, booking.attendeeEmail,
    booking.notes || '', booking.location || 'Video Call',
    booking.icsContent || '', booking.podUrl || null,
    booking.recurrence || null,
  );
  return result.changes > 0;
}

// ── Recurring bookings ──

const toNaive = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
  + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

const excludedDatesOf = (row) => String(row.excluded_dates || '').split(',').map((d) => d.trim()).filter(Boolean);

/**
 * The occurrences of a recurring booking row that start within
 * [from, to], as naive { start_time, end_time }. Occurrences cancelled on
 * their own are left out.
 */
function occurrencesOf(row, from, to) {
  const minutes = naiveDiffMinutes(row.start_time, row.end_time);
  if (!(minutes > 0)) return [];
  const timeOfDay = row.start_time.slice(11);
  const excluded = excludedDatesOf(row).map((date) => `${date} ${timeOfDay}`);
  return expandRRule(row.recurrence, row.start_time, from, to, excluded).map((occ) => ({
    start_time: toNaive(occ),
    end_time: toNaive(new Date(occ.getTime() + minutes * 60000)),
  }));
}

function recurringRows(slug) {
  return getDb().prepare(
    `SELECT start_time, end_time, recurrence, excluded_dates FROM bookings
     WHERE slug = ? AND status = 'confirmed' AND recurrence IS NOT NULL AND recurrence != ''`
  ).all(slug);
}

/**
 * Whether a confirmed booking on this page overlaps [start, end), counting
 * every occurrence of a recurring booking.
 * Times are naive "YYYY-MM-DD HH:MM", which compare correctly as text.
 */
export function hasOverlappingBooking(slug, start, end) {
  if (!slug) return false;
  const single = getDb().prepare(
    `SELECT 1 FROM bookings WHERE slug = ? AND status = 'confirmed' AND (recurrence IS NULL OR recurrence = '')
       AND start_time < ? AND end_time > ? LIMIT 1`
  ).get(slug, end, start);
  if (single) return true;

  // Occurrences that could reach into the range start at most a day before it
  const from = `${addDays(start.slice(0, 10), -1)} 00:00`;
  return recurringRows(slug).some((row) =>
    occurrencesOf(row, from, end).some((occ) => occ.start_time < end && occ.end_time > start));
}

/** Leave one occurrence (by its local date) out of a recurring booking. */
export function addBookingExcludedDate(id, slug, date) {
  if (!slug || !parseNaive(`${date} 00:00`)) return false;
  const row = getDb().prepare('SELECT excluded_dates FROM bookings WHERE id = ? AND slug = ?').get(id, slug);
  if (!row) return false;
  const dates = new Set(excludedDatesOf(row));
  dates.add(date);
  getDb().prepare('UPDATE bookings SET excluded_dates = ? WHERE id = ? AND slug = ?').run([...dates].join(','), id, slug);
  return true;
}

/** Cancel a booking only if it belongs to this booking page. */
export function cancelBookingForSlug(id, slug) {
  if (!slug) return false;
  return getDb().prepare(
    `UPDATE bookings SET status = 'cancelled' WHERE id = ? AND slug = ?`
  ).run(id, slug).changes > 0;
}

// ── Cancellations waiting to reach the Pod ──

export function markPodCancelPending(id) {
  getDb().prepare(`UPDATE bookings SET pod_cancel_pending = 1 WHERE id = ?`).run(id);
}

export function clearPodCancelPending(id) {
  getDb().prepare(`UPDATE bookings SET pod_cancel_pending = 0 WHERE id = ?`).run(id);
}

/** Cancelled bookings of one page whose Pod copy is still confirmed. Slug required, as for syncing. */
export function getPendingPodCancellations(slug) {
  if (typeof slug !== 'string' || slug === '') {
    throw new Error('getPendingPodCancellations requires a booking slug');
  }
  return getDb().prepare(
    `SELECT id, title, pod_url FROM bookings
     WHERE slug = ? AND status = 'cancelled' AND pod_cancel_pending = 1 AND pod_url IS NOT NULL AND pod_url != ''`
  ).all(slug);
}

/**
 * Unsynced confirmed bookings for one booking page. The slug is required:
 * bookings must only ever be synced into the Pod of the account they belong
 * to, so there is deliberately no "all accounts" mode.
 */
export function getUnsyncedBookings(slug) {
  if (typeof slug !== 'string' || slug === '') {
    throw new Error('getUnsyncedBookings requires a booking slug');
  }
  const db = getDb();
  return db.prepare(
    `SELECT * FROM bookings WHERE slug = ? AND synced_to_pod = 0 AND status = 'confirmed' ORDER BY created_at ASC`
  ).all(slug);
}

export function markBookingSynced(id, podResourceUrl) {
  const db = getDb();
  db.prepare(
    `UPDATE bookings SET synced_to_pod = 1, pod_url = ? WHERE id = ?`
  ).run(podResourceUrl, id);
}

/**
 * Bookings on one booking page.
 * @param {string} slug
 * @param {{ limit?: number, upcoming?: boolean, status?: 'confirmed'|'cancelled'|'all' }} [options]
 */
export function getBookingsBySlug(slug, { limit = 20, upcoming = true, status = 'confirmed' } = {}) {
  const db = getDb();
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')}`;
  const statusFilter = status === 'all' ? '' : `AND status = '${status === 'cancelled' ? 'cancelled' : 'confirmed'}'`;
  if (upcoming) {
    return db.prepare(
      `SELECT * FROM bookings WHERE slug = ? AND start_time >= ? ${statusFilter} ORDER BY start_time ASC LIMIT ?`
    ).all(slug, todayStr, limit);
  }
  return db.prepare(
    `SELECT * FROM bookings WHERE slug = ? ${statusFilter} ORDER BY start_time DESC LIMIT ?`
  ).all(slug, limit);
}

// ── Availability (SQLite fallback) ──
export function initAvailabilityTable() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Migrate legacy row (id=1, no slug) if it exists
  try {
    const legacy = db.prepare('SELECT id, data FROM availability WHERE slug IS NULL AND id = 1').get();
    if (legacy) {
      const parsed = JSON.parse(legacy.data);
      const slug = parsed.bookingSlug || null;
      if (slug) {
        db.prepare('UPDATE availability SET slug = ? WHERE id = 1').run(slug);
      }
    }
  } catch (_) { /* migration already done or no legacy data */ }
  // Ensure slug column exists (for databases created before v2.1)
  try {
    db.prepare('SELECT slug FROM availability LIMIT 0').run();
  } catch (_) {
    try {
      db.exec('ALTER TABLE availability ADD COLUMN slug TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_availability_slug ON availability(slug)');
      // Migrate existing rows
      const rows = db.prepare('SELECT id, data FROM availability WHERE slug IS NULL').all();
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.data);
          if (parsed.bookingSlug) {
            db.prepare('UPDATE availability SET slug = ? WHERE id = ?').run(parsed.bookingSlug, row.id);
          }
        } catch (_) {}
      }
    } catch (_) { /* column already exists */ }
  }
}

export function getAvailability(slug) {
  const db = getDb();
  initAvailabilityTable();
  if (!slug) return null;
  const row = db.prepare('SELECT data FROM availability WHERE slug = ?').get(slug);
  return row ? JSON.parse(row.data) : null;
}

export function saveAvailability(data, slug) {
  const db = getDb();
  initAvailabilityTable();
  if (!slug) return false;
  const json = JSON.stringify(data);
  const existing = db.prepare('SELECT id FROM availability WHERE slug = ?').get(slug);
  if (existing) {
    db.prepare('UPDATE availability SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE slug = ?').run(json, slug);
  } else {
    db.prepare('INSERT INTO availability (slug, data) VALUES (?, ?)').run(slug, json);
  }
  return true;
}

/**
 * Booking counts for one booking page, from the local table.
 *
 * "This week" and "this month" count meetings that take place in the
 * current week and month (every occurrence of a recurring booking), and
 * "upcoming" counts bookings still to come (a series once). The Pod-backed
 * statistics in services/calendar.js use the same definitions.
 *
 * @param {string} slug
 * @param {{ now: string, weekStart: string, weekEnd: string, monthStart: string, monthEnd: string }} periods
 *   Naive bounds in the account's timezone (see currentPeriods()).
 */
export function getBookingStats(slug, periods) {
  if (!slug) return { thisWeek: 0, thisMonth: 0, upcoming: 0, cancelled: 0, unsynced: 0 };
  const db = getDb();
  const single = `slug = ? AND status = 'confirmed' AND (recurrence IS NULL OR recurrence = '')`;
  const between = (from, to) =>
    db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE ${single} AND start_time >= ? AND start_time < ?`).get(slug, from, to).c;

  const series = recurringRows(slug);
  const occurrencesBetween = (from, to) =>
    series.reduce((sum, row) => sum + occurrencesOf(row, from, to).filter((o) => o.start_time < to).length, 0);
  // A series is upcoming while it has an occurrence left (looking ten years ahead)
  const horizon = `${Number(periods.now.slice(0, 4)) + 10}${periods.now.slice(4)}`;
  const upcomingSeries = series.filter((row) => occurrencesOf(row, periods.now, horizon).length > 0).length;

  return {
    thisWeek: between(periods.weekStart, periods.weekEnd) + occurrencesBetween(periods.weekStart, periods.weekEnd),
    thisMonth: between(periods.monthStart, periods.monthEnd) + occurrencesBetween(periods.monthStart, periods.monthEnd),
    upcoming: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE ${single} AND start_time >= ?`).get(slug, periods.now).c
      + upcomingSeries,
    cancelled: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE slug = ? AND status = 'cancelled'`).get(slug).c,
    unsynced: db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE slug = ? AND synced_to_pod = 0 AND status = 'confirmed'`).get(slug).c,
  };
}

export function getBookedSlots(slug, date) {
  const db = getDb();
  const single = db.prepare(
    `SELECT start_time, end_time FROM bookings
     WHERE slug = ? AND start_time LIKE ? AND status = 'confirmed' AND (recurrence IS NULL OR recurrence = '')`
  ).all(slug, `${date}%`);
  if (!parseNaive(`${date} 00:00`)) return single;

  const recurring = recurringRows(slug).flatMap((row) => occurrencesOf(row, `${date} 00:00`, `${date} 23:59`));
  return [...single, ...recurring];
}

export function cancelBooking(id) {
  const db = getDb();
  db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(id);
}

export function getBookingById(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id);
}
