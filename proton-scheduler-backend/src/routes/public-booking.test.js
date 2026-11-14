/**
 * Public booking rules, end to end through the real server: the slot list
 * follows the page's meeting length, and a booking is accepted only for a
 * time the page offers.
 *
 * Runs its own server so it has its own booking rate-limit budget
 * (10 attempts per 15 minutes per IP).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const SECRET = 'test-session-secret';
const COOKIE = 'solid-scheduler-session';
const FRONTEND = 'http://localhost:3000';
const NORA = 'https://nora.solidcommunity.net/profile/card#me';
const SLUG = 'nora';
const MONDAY = '2030-09-09';
const SUNDAY = '2030-09-08';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-public-'));
const DB_FILE = path.join(tmpDir, 'e2e.db');
let child;
let baseUrl;
let nora;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

/** A cookie-session cookie pair, signed the way keygrip does (HMAC-SHA1, base64url). */
function sessionCookie(session) {
  const value = Buffer.from(JSON.stringify(session)).toString('base64');
  const sig = crypto.createHmac('sha1', SECRET).update(`${COOKIE}=${value}`).digest('base64')
    .replace(/\/|\+|=/g, (c) => ({ '/': '_', '+': '-', '=': '' })[c]);
  return `${COOKIE}=${value}; ${COOKIE}.sig=${sig}`;
}

/** A signed-in client: cookie jar + CSRF token, sending the frontend Origin. */
async function signIn(webId) {
  const cookies = Object.fromEntries(sessionCookie({ webId }).split('; ').map((c) => c.split(/=(.*)/s).slice(0, 2)));
  const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const csrfRes = await fetch(`${baseUrl}/api/csrf-token`, { headers: { Cookie: jar() } });
  const { csrfToken } = await csrfRes.json();
  for (const line of csrfRes.headers.getSetCookie()) {
    const [name, value] = line.split(';')[0].split(/=(.*)/s);
    cookies[name] = value;
  }
  return (urlPath, options = {}) => fetch(`${baseUrl}${urlPath}`, {
    ...options,
    headers: { Cookie: jar(), Origin: FRONTEND, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
  });
}

const saveAvailability = (eventDuration) => nora('/api/availability', {
  method: 'PUT',
  body: JSON.stringify({
    eventDuration,
    timezone: 'Europe/Paris',
    bookingSlug: SLUG,
    monday: { enabled: true, start: '09:00', end: '11:00' },
    sunday: { enabled: false, start: '09:00', end: '17:00' },
  }),
});

const slots = async (date) => (await fetch(`${baseUrl}/api/public/${SLUG}/slots?date=${date}`)).json();

async function book(date, time) {
  const res = await fetch(`${baseUrl}/api/public/${SLUG}/book`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, time, name: 'Vera Visitor', email: 'vera@example.com' }),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DB_PATH: DB_FILE, FRONTEND_URL: FRONTEND,
      SESSION_SECRET: SECRET, NODE_ENV: 'test', REDIS_URL: '', DB_ENCRYPTION_KEY: '',
      // A server timezone far from the page's (Europe/Paris): times must not depend on it
      TZ: 'Pacific/Auckland' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  nora = await signIn(NORA);
  assert.equal((await saveAvailability(60)).status, 200);
});

after(() => {
  child?.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('public slots follow the meeting length', () => {
  it('offers one slot per meeting, only where a whole meeting fits', async () => {
    const day = await slots(MONDAY);
    assert.equal(day.duration, 60);
    assert.deepEqual(day.slots.map((s) => s.time), ['09:00', '10:00']);
    assert.deepEqual(day.slots.map((s) => s.displayTime), ['9:00 AM', '10:00 AM']);
  });

  it('offers nothing on a day that is switched off, or in the past', async () => {
    assert.deepEqual((await slots(SUNDAY)).slots, []);
    assert.deepEqual((await slots('2001-01-01')).slots, []);
  });

  it('rejects a date that is not a real day', async () => {
    const res = await fetch(`${baseUrl}/api/public/${SLUG}/slots?date=2030-13-45`);
    assert.equal(res.status, 400);
  });
});

describe('public bookings are accepted only for offered times', () => {
  it('books an offered slot for the full meeting length', async () => {
    const { status, body } = await book(MONDAY, '09:00');
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.booking.duration, 60);
    assert.equal(body.booking.endTime, '10:00 AM');
    assert.equal(body.booking.end, `${MONDAY}T10:00:00`);

    const sqlite = new Database(DB_FILE);
    const row = sqlite.prepare('SELECT start_time, end_time, ics_content FROM bookings WHERE id = ?').get(body.booking.id);
    sqlite.close();
    assert.equal(row.start_time, `${MONDAY} 09:00`);
    assert.equal(row.end_time, `${MONDAY} 10:00`);
    assert.match(row.ics_content, /DTEND;TZID=Europe\/Paris:20300909T100000/);
  });

  it('refuses times off the slot grid or outside working hours', async () => {
    assert.equal((await book(MONDAY, '10:30')).status, 409, 'would run past closing time');
    assert.equal((await book(MONDAY, '03:00')).status, 409, 'before opening time');
  });

  it('refuses a day that is switched off, and a date in the past', async () => {
    assert.equal((await book(SUNDAY, '10:00')).status, 409);
    assert.equal((await book('2001-01-01', '10:00')).status, 400);
  });

  it('refuses a time that overlaps an existing booking, even with a different start', async () => {
    // Shorter meetings from now on: 09:30 is on the grid but inside the 09:00–10:00 booking
    assert.equal((await saveAvailability(30)).status, 200);
    const day = await slots(MONDAY);
    assert.deepEqual(day.slots.map((s) => [s.time, s.isBooked]),
      [['09:00', true], ['09:30', true], ['10:00', false], ['10:30', false]]);

    const clash = await book(MONDAY, '09:30');
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error, 'Time slot already booked');

    const free = await book(MONDAY, '10:00');
    assert.equal(free.status, 201, JSON.stringify(free.body));
    assert.equal(free.body.booking.duration, 30);
  });
});

describe('a page whose owner has not saved their hours', () => {
  const OTTO = 'https://otto.solidcommunity.net/profile/card#me';
  const SATURDAY = '2030-09-07';

  before(async () => {
    // Signing in creates the account (slug "otto"); no availability is saved
    const res = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: sessionCookie({ webId: OTTO }) } });
    assert.equal(res.status, 200);
  });

  it('offers weekdays 09:00–17:00 and no weekends, as its availability says', async () => {
    const avail = await (await fetch(`${baseUrl}/api/public/otto/availability`)).json();
    assert.equal(avail.monday.enabled, true);
    assert.equal(avail.saturday.enabled, false);
    assert.equal(avail.sunday.enabled, false);

    const weekday = await (await fetch(`${baseUrl}/api/public/otto/slots?date=${MONDAY}`)).json();
    assert.equal(weekday.slots.length, 16);
    assert.equal(weekday.slots[0].time, '09:00');
    assert.equal(weekday.slots.at(-1).time, '16:30');

    for (const date of [SATURDAY, SUNDAY]) {
      assert.deepEqual((await (await fetch(`${baseUrl}/api/public/otto/slots?date=${date}`)).json()).slots, []);
    }
  });

  it('refuses a weekend booking', async () => {
    const res = await fetch(`${baseUrl}/api/public/otto/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: SATURDAY, time: '10:00', name: 'Vera Visitor', email: 'vera@example.com' }),
    });
    assert.equal(res.status, 409);
  });
});

describe('dashboard bookings and the public page share one calendar', () => {
  const NEXT_MONDAY = '2030-09-16';
  const dashboardBook = (time) => nora('/api/bookings', {
    method: 'POST',
    body: JSON.stringify({ date: NEXT_MONDAY, time, name: 'Dana Client', email: 'dana@example.com' }),
  });
  const slotState = async () => Object.fromEntries(
    (await slots(NEXT_MONDAY)).slots.map((s) => [s.time, s.isBooked]));

  it("stores a dashboard booking at the chosen time in the page's timezone, and takes the slot", async () => {
    const res = await dashboardBook('09:30');
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.booking.startTime, '9:30 AM');
    assert.equal(body.booking.endTime, '10:00 AM');
    assert.equal(body.booking.date, 'Monday, September 16, 2030');
    // 09:30 in Paris (UTC+2 in September), whatever the server's own timezone
    assert.equal(body.booking.start, '2030-09-16T07:30:00.000Z');

    const sqlite = new Database(DB_FILE);
    const row = sqlite.prepare('SELECT start_time, end_time FROM bookings WHERE id = ?').get(body.booking.id);
    sqlite.close();
    assert.deepEqual({ ...row }, { start_time: `${NEXT_MONDAY} 09:30`, end_time: `${NEXT_MONDAY} 10:00` });

    assert.deepEqual(await slotState(), { '09:00': false, '09:30': true, '10:00': false, '10:30': false });
  });

  it('refuses a dashboard booking over a time a visitor has booked', async () => {
    const sqlite = new Database(DB_FILE);
    sqlite.prepare(`INSERT INTO bookings (id, slug, title, start_time, end_time, attendee_name, attendee_email)
      VALUES ('visitor-1', ?, 'Visitor meeting', ?, ?, 'Vera', 'vera@example.com')`)
      .run(SLUG, `${NEXT_MONDAY} 10:00`, `${NEXT_MONDAY} 10:30`);
    sqlite.close();

    const res = await dashboardBook('10:00');
    assert.equal(res.status, 409);
    assert.equal((await dashboardBook('25:00')).status, 400);
  });

  it("queues the Pod cancellation when a visitor cancels a booking that is already in the owner's Pod", async () => {
    const sqlite = new Database(DB_FILE);
    sqlite.prepare(`UPDATE bookings SET synced_to_pod = 1, pod_url = 'https://pod.example/nora/solid-scheduler/bookings/visitor-1.ttl'
      WHERE id = 'visitor-1'`).run();
    sqlite.close();

    const res = await fetch(`${baseUrl}/api/public/${SLUG}/bookings/visitor-1`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    const after = new Database(DB_FILE);
    const row = after.prepare("SELECT status, pod_cancel_pending FROM bookings WHERE id = 'visitor-1'").get();
    after.close();
    assert.deepEqual({ ...row }, { status: 'cancelled', pod_cancel_pending: 1 });
    assert.equal((await slotState())['10:00'], false, 'slot is free again');
  });
});
