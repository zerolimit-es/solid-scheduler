import { getDb } from './database.js';

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
}

export function createBooking(booking) {
  const db = getDb();
  db.prepare(`
    INSERT INTO bookings (id, slug, title, start_time, end_time, organizer_name, organizer_email,
      attendee_name, attendee_email, notes, location, status, ics_content, synced_to_pod,
      assigned_member_id, assigned_member_name, assigned_member_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    booking.id, booking.slug, booking.title,
    booking.start, booking.end,
    booking.organizerName || '', booking.organizerEmail || '',
    booking.attendeeName, booking.attendeeEmail,
    booking.notes || '', booking.location || 'Video Call',
    'confirmed', booking.icsContent || '',
    booking.assignedMemberId || null,
    booking.assignedMemberName || null,
    booking.assignedMemberEmail || null,
  );
  return booking;
}

export function getUnsyncedBookings(slug) {
  const db = getDb();
  if (!slug) {
    return db.prepare(
      `SELECT * FROM bookings WHERE synced_to_pod = 0 AND status = 'confirmed' ORDER BY created_at ASC`
    ).all();
  }
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

export function getBookingsBySlug(slug, { limit = 20, upcoming = true } = {}) {
  const db = getDb();
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')}`;
  if (upcoming) {
    return db.prepare(
      `SELECT * FROM bookings WHERE slug = ? AND start_time >= ? AND status = 'confirmed' ORDER BY start_time ASC LIMIT ?`
    ).all(slug, todayStr, limit);
  }
  return db.prepare(
    `SELECT * FROM bookings WHERE slug = ? AND status = 'confirmed' ORDER BY start_time DESC LIMIT ?`
  ).all(slug, limit);
}

export function getAllUpcomingBookings({ limit = 20 } = {}) {
  const db = getDb();
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')}`;
  return db.prepare(
    `SELECT * FROM bookings WHERE start_time >= ? AND status = 'confirmed' ORDER BY start_time ASC LIMIT ?`
  ).all(todayStr, limit);
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

export function getBookingStats(slug) {
  const db = getDb();
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-${now.getDate().toString().padStart(2,'0')}`;
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  const weekStr = `${startOfWeek.getFullYear()}-${(startOfWeek.getMonth()+1).toString().padStart(2,'0')}-${startOfWeek.getDate().toString().padStart(2,'0')}`;
  const monthStr = `${now.getFullYear()}-${(now.getMonth()+1).toString().padStart(2,'0')}-01`;

  const where = slug ? 'slug = ? AND' : '';
  const params = slug ? [slug] : [];

  const thisWeek = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE ${where} start_time >= ? AND status = 'confirmed'`).get(...params, weekStr).c;
  const thisMonth = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE ${where} start_time >= ? AND status = 'confirmed'`).get(...params, monthStr).c;
  const upcoming = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE ${where} start_time >= ? AND status = 'confirmed'`).get(...params, todayStr).c;
  const unsynced = db.prepare(`SELECT COUNT(*) as c FROM bookings WHERE ${where} synced_to_pod = 0 AND status = 'confirmed'`).get(...params).c;

  return { thisWeek, thisMonth, upcoming, unsynced };
}

// ── Analytics queries (Business tier) ──────────────────────────────────
export function getAnalyticsOverview(slug, from, to) {
  const db = getDb();
  const total = db.prepare(
    `SELECT COUNT(*) as c FROM bookings WHERE slug = ? AND created_at >= ? AND created_at <= ?`
  ).get(slug, from, to).c;
  const confirmed = db.prepare(
    `SELECT COUNT(*) as c FROM bookings WHERE slug = ? AND created_at >= ? AND created_at <= ? AND status = 'confirmed'`
  ).get(slug, from, to).c;
  const cancelled = db.prepare(
    `SELECT COUNT(*) as c FROM bookings WHERE slug = ? AND created_at >= ? AND created_at <= ? AND status = 'cancelled'`
  ).get(slug, from, to).c;

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  const weekStr = `${startOfWeek.getFullYear()}-${String(startOfWeek.getMonth() + 1).padStart(2, '0')}-${String(startOfWeek.getDate()).padStart(2, '0')}`;
  const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const thisWeek = db.prepare(
    `SELECT COUNT(*) as c FROM bookings WHERE slug = ? AND start_time >= ? AND status = 'confirmed'`
  ).get(slug, weekStr).c;
  const thisMonth = db.prepare(
    `SELECT COUNT(*) as c FROM bookings WHERE slug = ? AND start_time >= ? AND status = 'confirmed'`
  ).get(slug, monthStr).c;

  return { total, confirmed, cancelled, thisWeek, thisMonth };
}

export function getBookingsOverTime(slug, from, to) {
  const db = getDb();
  return db.prepare(`
    SELECT DATE(start_time) as date, COUNT(*) as count
    FROM bookings WHERE slug = ? AND start_time >= ? AND start_time <= ?
    GROUP BY DATE(start_time) ORDER BY date ASC
  `).all(slug, from, to);
}

export function getPeakHours(slug, from, to) {
  const db = getDb();
  return db.prepare(`
    SELECT CAST(strftime('%H', start_time) AS INTEGER) as hour, COUNT(*) as count
    FROM bookings WHERE slug = ? AND start_time >= ? AND start_time <= ? AND status = 'confirmed'
    GROUP BY hour ORDER BY hour ASC
  `).all(slug, from, to);
}

export function getPeakDays(slug, from, to) {
  const db = getDb();
  return db.prepare(`
    SELECT CAST(strftime('%w', start_time) AS INTEGER) as dayOfWeek, COUNT(*) as count
    FROM bookings WHERE slug = ? AND start_time >= ? AND start_time <= ? AND status = 'confirmed'
    GROUP BY dayOfWeek ORDER BY dayOfWeek ASC
  `).all(slug, from, to);
}

export function getTeamUtilization(slug, from, to) {
  const db = getDb();
  return db.prepare(`
    SELECT assigned_member_id as memberId, assigned_member_name as memberName, COUNT(*) as count
    FROM bookings WHERE slug = ? AND start_time >= ? AND start_time <= ? AND status = 'confirmed'
      AND assigned_member_id IS NOT NULL
    GROUP BY assigned_member_id, assigned_member_name ORDER BY count DESC
  `).all(slug, from, to);
}

export function getRecentBookings(slug, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT id, title, start_time, end_time, attendee_name, attendee_email, status,
           assigned_member_name, created_at
    FROM bookings WHERE slug = ? ORDER BY created_at DESC LIMIT ?
  `).all(slug, limit);
}

export function getBookedSlots(slug, date) {
  const db = getDb();
  return db.prepare(
    `SELECT start_time, end_time FROM bookings WHERE slug = ? AND start_time LIKE ? AND status = 'confirmed'`
  ).all(slug, `${date}%`);
}

export function cancelBooking(id) {
  const db = getDb();
  db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(id);
}

export function getBookingById(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(id);
}

export function deleteSyncedBookings(slug, olderThanDays = 30) {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  const cutoffStr = cutoff.toISOString();
  db.prepare(
    `DELETE FROM bookings WHERE slug = ? AND synced_to_pod = 1 AND created_at < ?`
  ).run(slug, cutoffStr);
}

// Clear old synced bookings (older than N days)
export function clearSyncedBookings(daysOld = 30) {
  if (daysOld === 0) {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as count FROM bookings WHERE synced_to_pod = 1').get();
    const result = db.prepare('DELETE FROM bookings WHERE synced_to_pod = 1').run();
    return { deleted: result.changes, cutoffDate: 'all', eligible: count.count };
  }
  const db = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  
  const count = db.prepare(`
    SELECT COUNT(*) as count FROM bookings 
    WHERE synced_to_pod = 1 AND start_time < ?
  `).get(cutoffStr);
  
  const result = db.prepare(`
    DELETE FROM bookings 
    WHERE synced_to_pod = 1 AND start_time < ?
  `).run(cutoffStr);
  
  return { deleted: result.changes, cutoffDate: cutoffStr, eligible: count.count };
}

// Get cleanup stats
export function getCleanupStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM bookings').get();
  const synced = db.prepare('SELECT COUNT(*) as count FROM bookings WHERE synced_to_pod = 1').get();
  const unsynced = db.prepare('SELECT COUNT(*) as count FROM bookings WHERE synced_to_pod = 0').get();
  const oldSynced30 = db.prepare(`
    SELECT COUNT(*) as count FROM bookings 
    WHERE synced_to_pod = 1 AND start_time < date('now', '-30 days')
  `).get();
  const oldSynced7 = db.prepare(`
    SELECT COUNT(*) as count FROM bookings 
    WHERE synced_to_pod = 1 AND start_time < date('now', '-7 days')
  `).get();
  const dbSize = db.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get();
  const slugBreakdown = db.prepare(
    `SELECT slug, synced_to_pod, COUNT(*) as count FROM bookings GROUP BY slug, synced_to_pod ORDER BY slug`
  ).all();

  return {
    total: total.count,
    synced: synced.count,
    unsynced: unsynced.count,
    clearable7: oldSynced7.count,
    clearable30: oldSynced30.count,
    dbSizeBytes: dbSize.size,
    slugs: slugBreakdown,
  };
}
