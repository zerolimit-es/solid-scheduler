/**
 * Blocked time (#75), end to end through the real server: the calendar event
 * routes, ICS import, and the effect on the public booking page.
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

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const SECRET = 'test-session-secret';
const COOKIE = 'solid-scheduler-session';
const FRONTEND = 'http://localhost:3000';
const ALICE = 'https://alice.solidcommunity.net/profile/card#me';
const MALLORY = 'https://mallory.solidcommunity.net/profile/card#me';
const DAY = '2030-09-10'; // a Tuesday; default availability is 09:00–17:00
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-events-'));
let child;
let baseUrl;

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});

function sessionCookie(session) {
  // A signed-in session carries the ID and sign-in time the server checks
  if (session.webId && !session.sid) session = { sid: crypto.randomUUID(), loginAt: Date.now(), ...session };
  const value = Buffer.from(JSON.stringify(session)).toString('base64');
  const sig = crypto.createHmac('sha1', SECRET).update(`${COOKIE}=${value}`).digest('base64')
    .replace(/\/|\+|=/g, (c) => ({ '/': '_', '+': '-', '=': '' })[c]);
  return `${COOKIE}=${value}; ${COOKIE}.sig=${sig}`;
}

function updateJar(jar, res) {
  const cookies = Object.fromEntries(jar.split('; ').filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2)));
  for (const line of res.headers.getSetCookie()) {
    const [name, value] = line.split(';')[0].split(/=(.*)/s);
    cookies[name] = value;
  }
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** A signed-in client: carries its cookie jar and CSRF token like the SPA. */
async function client(webId) {
  let jar = sessionCookie({ webId });
  const first = await fetch(`${baseUrl}/api/csrf-token`, { headers: { Cookie: jar } });
  const { csrfToken } = await first.json();
  jar = updateJar(jar, first);
  const call = async (method, p, { json, text } = {}) => {
    const headers = { Cookie: jar, Origin: FRONTEND, 'X-CSRF-Token': csrfToken };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (text !== undefined) { headers['Content-Type'] = 'text/calendar'; body = text; }
    const res = await fetch(`${baseUrl}${p}`, { method, headers, body });
    jar = updateJar(jar, res);
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { get: (p) => call('GET', p), post: (p, o) => call('POST', p, o), put: (p, o) => call('PUT', p, o), del: (p) => call('DELETE', p) };
}

async function slug(webId) {
  // The tenant's booking slug: read it from the feed-token side effect (tenant exists after first request)
  const { default: Database } = await import('better-sqlite3-multiple-ciphers');
  const db = new Database(path.join(tmpDir, 'db.sqlite'), { readonly: true });
  try { return db.prepare('SELECT booking_slug FROM tenants WHERE webid = ?').get(webId).booking_slug; } finally { db.close(); }
}

async function freeSlots(bookingSlug, date = DAY) {
  const res = await fetch(`${baseUrl}/api/public/${bookingSlug}/slots?date=${date}`);
  const { slots } = await res.json();
  return slots.filter((s) => !s.isBooked).map((s) => s.time);
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(tmpDir, 'db.sqlite'), SESSION_SECRET: SECRET,
      FRONTEND_URL: FRONTEND, NODE_ENV: 'test', REDIS_URL: '', DB_ENCRYPTION_KEY: '', CALDAV_ENABLED: 'false' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  child?.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('blocked time (#75)', () => {
  let alice;
  let aliceSlug;
  let eventId;

  before(async () => {
    alice = await client(ALICE);
    await alice.get('/api/calendar/feed-token'); // creates the tenant
    aliceSlug = await slug(ALICE);
  });

  it('refuses anonymous requests', async () => {
    assert.equal((await fetch(`${baseUrl}/api/calendar/events?from=${DAY}&to=${DAY}`)).status, 401);
  });

  it('a timed event blocks every slot it overlaps, not just its first', async () => {
    assert.ok((await freeSlots(aliceSlug)).includes('10:30'));
    const created = await alice.post('/api/calendar/events', { json: { title: 'Dentist', start: `${DAY} 10:15`, end: `${DAY} 11:45` } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    eventId = created.body.event.id;
    assert.equal(created.body.event.start, `${DAY} 10:15`);

    const free = await freeSlots(aliceSlug);
    for (const t of ['10:00', '10:30', '11:00', '11:30']) assert.ok(!free.includes(t), `${t} should be blocked`);
    for (const t of ['09:30', '12:00']) assert.ok(free.includes(t), `${t} should be free`);
  });

  it('a direct booking into blocked time is refused', async () => {
    const res = await fetch(`${baseUrl}/api/public/${aliceSlug}/book`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: DAY, time: '11:00', name: 'Visitor', email: 'v@example.com' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'Time slot unavailable');
  });

  it('lists events overlapping a range, and updates them', async () => {
    const list = await alice.get(`/api/calendar/events?from=${DAY}&to=${DAY}`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.events.map((e) => e.title), ['Dentist']);

    const moved = await alice.put(`/api/calendar/events/${eventId}`, { json: { start: `${DAY} 14:00`, end: `${DAY} 15:00` } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.event.title, 'Dentist');
    const free = await freeSlots(aliceSlug);
    assert.ok(free.includes('10:30') && !free.includes('14:30'));
  });

  it('an all-day event blocks the whole day', async () => {
    const res = await alice.post('/api/calendar/events', { json: { title: 'Holiday', allDay: true, start: '2030-09-11', end: '2030-09-11' } });
    assert.equal(res.status, 201);
    assert.equal(res.body.event.end, '2030-09-12 00:00');
    assert.deepEqual(await freeSlots(aliceSlug, '2030-09-11'), []);
    assert.ok((await freeSlots(aliceSlug, '2030-09-12')).length > 0);
  });

  it('a weekly event blocks the same time every week', async () => {
    const res = await alice.post('/api/calendar/events', {
      json: { title: 'Standup', start: '2030-09-16 09:00', end: '2030-09-16 09:30', recurrence: 'FREQ=WEEKLY;BYDAY=MO' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    for (const monday of ['2030-09-16', '2030-09-23', '2030-09-30']) {
      const free = await freeSlots(aliceSlug, monday);
      assert.ok(!free.includes('09:00') && free.includes('09:30'), monday);
    }
  });

  it('imports an .ics file in the organizer timezone, skipping past, cancelled, free and duplicate events', async () => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0',
      'BEGIN:VEVENT', 'UID:imp-1@example', 'SUMMARY:Flight', 'DTSTART:20300917T120000Z', 'DTEND:20300917T140000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:imp-2@example', 'SUMMARY:Old', 'DTSTART:20200101T100000Z', 'DTEND:20200101T110000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:imp-3@example', 'SUMMARY:Called off', 'STATUS:CANCELLED', 'DTSTART:20300918T100000Z', 'DTEND:20300918T110000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:imp-4@example', 'SUMMARY:Focus (free)', 'TRANSP:TRANSPARENT', 'DTSTART:20300918T100000Z', 'DTEND:20300918T110000Z', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const first = await alice.post('/api/calendar/import', { text: ics });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.imported, 1);
    assert.deepEqual(first.body.skipped, { past: 1, cancelled: 1, free: 1, duplicate: 0, invalid: 0 });

    // 12:00–14:00 UTC is 14:00–16:00 in Paris (default availability timezone)
    const free = await freeSlots(aliceSlug, '2030-09-17');
    for (const t of ['14:00', '14:30', '15:00', '15:30']) assert.ok(!free.includes(t), t);
    assert.ok(free.includes('13:30') && free.includes('16:00'));

    const again = await alice.post('/api/calendar/import', { text: ics });
    assert.equal(again.body.imported, 0);
    assert.equal(again.body.skipped.duplicate, 1);
  });

  it("keeps accounts apart: others can't see, change or delete your events", async () => {
    const mallory = await client(MALLORY);
    const list = await mallory.get(`/api/calendar/events?from=${DAY}&to=2030-09-30`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.events, []);
    assert.equal((await mallory.put(`/api/calendar/events/${eventId}`, { json: { title: 'x' } })).status, 404);
    assert.equal((await mallory.del(`/api/calendar/events/${eventId}`)).status, 404);
  });

  it('deleting an event frees its slots', async () => {
    assert.equal((await alice.del(`/api/calendar/events/${eventId}`)).status, 200);
    assert.ok((await freeSlots(aliceSlug)).includes('14:30'));
    assert.equal((await alice.del(`/api/calendar/events/${eventId}`)).status, 404);
  });

  it('validates input', async () => {
    const bad = [
      [{ start: `${DAY} 10:00`, end: `${DAY} 11:00` }, /title/],
      [{ title: 'x', start: `${DAY} 11:00`, end: `${DAY} 10:00` }, /after start/],
      [{ title: 'x', start: '2030-02-30 10:00', end: '2030-02-30 11:00' }, /start/],
      [{ title: 'x', start: `${DAY} 10:00`, end: '2030-12-31 10:00' }, /31 days/],
      [{ title: 'x', start: `${DAY} 10:00`, end: `${DAY} 11:00`, recurrence: 'not a rule' }, /RRULE/],
      [{ title: 'x', start: `${DAY} 10:00`, end: `${DAY} 11:00`, color: 'red' }, /colour/],
    ];
    for (const [json, msg] of bad) {
      const res = await alice.post('/api/calendar/events', { json });
      assert.equal(res.status, 400, JSON.stringify(json));
      assert.match(res.body.error, msg);
    }
    assert.equal((await alice.get('/api/calendar/events?from=2030-09-10&to=2030-01-01')).status, 400);
    assert.equal((await alice.post('/api/calendar/import', { text: 'hello' })).status, 400);
  });

  it('requires the CSRF token for changes', async () => {
    const res = await fetch(`${baseUrl}/api/calendar/events`, {
      method: 'POST',
      headers: { Cookie: sessionCookie({ webId: ALICE }), Origin: FRONTEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', start: `${DAY} 10:00`, end: `${DAY} 11:00` }),
    });
    assert.equal(res.status, 403);
  });
});
