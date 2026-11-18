/**
 * The signed-in dashboard reads bookings from the Pod, while visitors'
 * bookings are stored locally first. These tests run the bookings routes
 * against a stand-in Pod and check that the two stay in step:
 * a visitor's booking shows up without signing in again, it can be
 * cancelled, and "upcoming" means upcoming.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-dashboard-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DB_ENCRYPTION_KEY;

// The hosts below are stand-ins and the tests make no real requests. The
// server only contacts public addresses, so have every name resolve to one.
dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];

const WEBID = 'https://uma.solidcommunity.net/profile/card#me';
const POD = 'https://uma.solidcommunity.net/';
const BOOKINGS = `${POD}solid-scheduler/bookings/`;
let server, baseUrl, sqlite, pod;
const realFetch = globalThis.fetch;
let profileListsPod = true;
let sessionPodUrl = null;

/** An in-memory Pod: stores Turtle by URL, lists containers, can be made read-only. */
function fakePod() {
  const files = new Map();
  const state = { readOnly: false, writes: [] };
  const respond = (url, body, init) => {
    const res = new Response(body, init);
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  const turtle = (url, body) => respond(url, body, { status: 200, headers: { 'Content-Type': 'text/turtle' } });

  state.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url).split('#')[0];
    const method = (init.method || 'GET').toUpperCase();

    if (method === 'GET' || method === 'HEAD') {
      if (url === WEBID.split('#')[0]) {
        return turtle(url, `<${WEBID}> <http://www.w3.org/ns/pim/space#storage> <${POD}> .`);
      }
      if (url.endsWith('/')) {
        const children = [...files.keys()].filter((k) => k.startsWith(url) && !k.slice(url.length).includes('/'));
        const contains = children.map((c) => `<${url}> <http://www.w3.org/ns/ldp#contains> <${c}> .`).join('\n');
        return turtle(url, `<${url}> a <http://www.w3.org/ns/ldp#Container> .\n${contains}`);
      }
      return files.has(url) ? turtle(url, files.get(url)) : respond(url, 'Not found', { status: 404 });
    }

    if (url.endsWith('/')) return respond(url, null, { status: 201 }); // container creation
    if (state.readOnly) return respond(url, 'Forbidden', { status: 403 });

    const body = String(init.body ?? '');
    state.writes.push({ method, url, body });
    if (method === 'PUT') files.set(url, body);
    if (method === 'PATCH' && /EventCancelled/.test(body) && files.has(url)) {
      files.set(url, files.get(url).replace(/EventConfirmed/g, 'EventCancelled'));
    }
    if (method === 'DELETE') files.delete(url);
    return respond(url, null, { status: 205 });
  };
  state.files = files;
  return state;
}

const insert = (id, start, end, extra = {}) => sqlite.prepare(`
  INSERT INTO bookings (id, slug, title, start_time, end_time, attendee_name, attendee_email, synced_to_pod, pod_url)
  VALUES (?, 'uma', ?, ?, ?, 'Vik Visitor', 'vik@example.com', ?, ?)`)
  .run(id, extra.title || `Meeting ${id}`, start, end, extra.synced ? 1 : 0, extra.podUrl || null);
const row = (id) => sqlite.prepare('SELECT status, synced_to_pod, pod_url, pod_cancel_pending FROM bookings WHERE id = ?').get(id);
const get = async (urlPath) => (await fetch(`${baseUrl}${urlPath}`)).json();

before(async () => {
  const { sessionManager } = await import('../middleware/auth.js');
  const { getDb } = await import('../cloud/models/database.js');
  const { initBookingsTable } = await import('../cloud/models/bookings-db.js');
  const { ensureTenant } = await import('../cloud/services/tenants.js');
  const express = (await import('express')).default;
  const bookingsRoutes = (await import('./bookings.js')).default;
  const availabilityRoutes = (await import('./availability.js')).default;

  sqlite = getDb();
  initBookingsTable();
  const { tenant } = ensureTenant(WEBID, { podUrl: POD });
  assert.equal(tenant.booking_slug, 'uma');

  // Pod discovery reads the public WebID profile with the plain global fetch
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.startsWith('https://uma.solidcommunity.net/')) {
      const triple = profileListsPod ? `<${WEBID}> <http://www.w3.org/ns/pim/space#storage> <${POD}> .` : '';
      return new Response(triple,
        { headers: { 'Content-Type': 'text/turtle' } });
    }
    return realFetch(input, init);
  };

  // Stand in for a live Solid session: every request is Uma, talking to the fake Pod
  sessionManager.getAuthenticatedFetch = async () => {
    if (!pod) throw new Error('Session not authenticated');
    return pod.fetch;
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { webId: WEBID, podUrl: sessionPodUrl };
    req.tenant = { ...sqlite.prepare('SELECT * FROM tenants WHERE webid = ?').get(WEBID), solid_pod_url: null };
    next();
  });
  app.use('/api/bookings', bookingsRoutes);
  app.use('/api/availability', availabilityRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  profileListsPod = true;
  sessionPodUrl = null;
  pod = fakePod();
  sqlite.prepare('DELETE FROM bookings').run();
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("a visitor's booking reaches the signed-in dashboard", () => {
  it('is pushed to the Pod when the dashboard loads, and listed', async () => {
    insert('booking-new', '2030-09-16 10:00', '2030-09-16 10:30');

    const { bookings } = await get('/api/bookings/upcoming');
    assert.deepEqual(bookings.map((b) => b.id), ['booking-new']);
    assert.equal(bookings[0].attendee.email, 'vik@example.com');
    assert.equal(bookings[0].start, '2030-09-16T08:00:00.000Z', '10:00 in the account timezone (Paris)');

    assert.equal(row('booking-new').synced_to_pod, 1);
    assert.equal(row('booking-new').pod_url, `${BOOKINGS}booking-new.ttl`);
    assert.ok(pod.files.has(`${BOOKINGS}booking-new.ttl`));

    // Loading again does not write it a second time
    const writes = pod.writes.length;
    assert.equal((await get('/api/bookings/upcoming')).bookings.length, 1);
    assert.equal(pod.writes.length, writes);
  });

  it('is still listed when the Pod cannot be written to', async () => {
    pod.readOnly = true;
    insert('booking-stuck', '2030-09-16 10:00', '2030-09-16 10:30');

    assert.deepEqual((await get('/api/bookings/upcoming')).bookings.map((b) => b.id), ['booking-stuck']);
    assert.deepEqual((await get('/api/bookings')).bookings.map((b) => b.id), ['booking-stuck']);
    assert.equal(row('booking-stuck').synced_to_pod, 0, 'stays pending for the next push');
  });
});

describe('upcoming means upcoming', () => {
  it('leaves out past meetings and lists the soonest first, up to the limit', async () => {
    insert('past', '2020-01-06 10:00', '2020-01-06 10:30');
    insert('later', '2030-09-18 10:00', '2030-09-18 10:30');
    insert('sooner', '2030-09-16 10:00', '2030-09-16 10:30');
    insert('latest', '2030-09-20 10:00', '2030-09-20 10:30');

    assert.deepEqual((await get('/api/bookings/upcoming')).bookings.map((b) => b.id), ['sooner', 'later', 'latest']);
    assert.deepEqual((await get('/api/bookings/upcoming?limit=2')).bookings.map((b) => b.id), ['sooner', 'later']);
    // The full list still has everything, oldest first
    assert.deepEqual((await get('/api/bookings')).bookings.map((b) => b.id), ['past', 'sooner', 'later', 'latest']);
  });

  it('lists the same way from local data when the Pod is out of reach', async () => {
    insert('past', '2020-01-06 10:00', '2020-01-06 10:30');
    insert('sooner', '2030-09-16 10:00', '2030-09-16 10:30');
    // A weekly series that began long ago and is still running
    sqlite.prepare(`INSERT INTO bookings (id, slug, title, start_time, end_time, attendee_name, attendee_email, recurrence)
      VALUES ('series', 'uma', 'Weekly', '2020-01-06 09:00', '2020-01-06 09:30', 'Rae', 'rae@example.com', 'FREQ=WEEKLY;BYDAY=MO')`).run();
    pod = null; // Solid session lost

    const res = await get('/api/bookings/upcoming');
    assert.equal(res.source, 'local');
    assert.deepEqual(res.bookings.map((b) => b.id), ['series', 'sooner']);
    const [series, sooner] = res.bookings;
    // Exact moments, as the Pod gives them (10:00 Paris in September is 08:00 UTC)
    assert.equal(sooner.start, '2030-09-16T08:00:00.000Z');
    assert.equal(sooner.end, '2030-09-16T08:30:00.000Z');
    // The series once, at its next occurrence: a Monday 09:00 Paris from now on
    assert.equal(series.seriesStart, '2020-01-06T08:00:00.000Z');
    assert.ok(new Date(series.start) > new Date(), 'the next occurrence is still to come');
    const parisWall = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit' })
      .format(new Date(series.start));
    assert.equal(parisWall, 'Mon 09:00');
    assert.ok(series.recurrenceDescription);
  });
});

describe('cancelling from the dashboard', () => {
  const cancel = (id) => fetch(`${baseUrl}/api/bookings/${id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notify: false }),
  });

  it("cancels a visitor's booking that had not reached the Pod yet, there and locally", async () => {
    insert('booking-fresh', '2030-09-16 10:00', '2030-09-16 10:30');

    const res = await cancel('booking-fresh');
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(row('booking-fresh').status, 'cancelled');
    assert.match(pod.files.get(`${BOOKINGS}booking-fresh.ttl`), /EventCancelled/);
    assert.deepEqual((await get('/api/bookings/upcoming')).bookings, []);
  });

  it('cancels locally when the Pod cannot be written to', async () => {
    pod.readOnly = true;
    insert('booking-local', '2030-09-16 10:00', '2030-09-16 10:30');

    assert.equal((await cancel('booking-local')).status, 200);
    assert.equal(row('booking-local').status, 'cancelled');
    assert.deepEqual((await get('/api/bookings/upcoming')).bookings, []);
  });

  it('cancels locally with no Pod session, and queues the Pod copy if there is one', async () => {
    insert('booking-synced', '2030-09-16 10:00', '2030-09-16 10:30', { synced: true, podUrl: `${BOOKINGS}booking-synced.ttl` });
    pod = null; // Solid session lost

    assert.equal((await cancel('booking-synced')).status, 200);
    assert.equal(row('booking-synced').status, 'cancelled');
    assert.equal(row('booking-synced').pod_cancel_pending, 1);
  });

  it("answers 404 for an unknown booking or another account's", async () => {
    sqlite.prepare(`INSERT INTO bookings (id, slug, title, start_time, end_time, attendee_name, attendee_email)
      VALUES ('other-1', 'someone-else', 'Not yours', '2030-09-16 10:00', '2030-09-16 10:30', 'X', 'x@example.com')`).run();
    assert.equal((await cancel('no-such-booking')).status, 404);
    assert.equal((await cancel('other-1')).status, 404);
    assert.equal(sqlite.prepare("SELECT status FROM bookings WHERE id = 'other-1'").get().status, 'confirmed');
  });
});

describe('when the WebID profile lists no Pod', () => {
  it('uses the Pod URL the user set by hand', async () => {
    profileListsPod = false;
    sessionPodUrl = POD;
    insert('booking-manual', '2030-09-16 10:00', '2030-09-16 10:30');

    assert.deepEqual((await get('/api/bookings/upcoming')).bookings.map((b) => b.id), ['booking-manual']);
    assert.ok(pod.files.has(`${BOOKINGS}booking-manual.ttl`));
  });

  it('works from local data when there is no Pod at all, instead of failing', async () => {
    profileListsPod = false;
    insert('booking-nopod', '2030-09-16 10:00', '2030-09-16 10:30');

    const res = await fetch(`${baseUrl}/api/bookings/upcoming`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'local');
    assert.deepEqual(body.bookings.map((b) => b.id), ['booking-nopod']);
    assert.equal((await fetch(`${baseUrl}/api/bookings/stats`)).status, 200);
    assert.equal(pod.writes.length, 0);
  });
});

describe('recurring bookings', () => {
  const book = (body) => fetch(`${baseUrl}/api/bookings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Wes Client', email: 'wes@example.com', ...body }),
  });
  const MONDAY = '2030-09-16';

  // Dashboard bookings need saved availability (the Pod copy is read for the organizer's details)
  beforeEach(async () => {
    const { saveAvailability } = await import('../cloud/models/bookings-db.js');
    saveAvailability({ eventDuration: 30, timezone: 'Europe/Paris', name: 'Uma' }, 'uma');
    const solid = (await import('../services/solid.js')).default;
    await solid.saveAvailability(POD, { eventDuration: 30, timezone: 'Europe/Paris', name: 'Uma', email: 'uma@example.com', days: {} }, pod.fetch);
  });

  it("updates the Pod copy's repeat rule when a timezone change moves the series to another weekday", async () => {
    // Every Monday at 20:00 in Paris: Tuesday 03:00 in Tokyo
    const res = await book({ date: MONDAY, time: '20:00', recurrence: { frequency: 'WEEKLY', byDay: ['MO'] } });
    const { booking } = await res.json();
    assert.equal(res.status, 201);
    const local = () => sqlite.prepare('SELECT recurrence, pod_url, pod_rule_pending FROM bookings WHERE id = ?').get(booking.id);
    assert.ok(local().pod_url, 'saved to the Pod');

    pod.writes.length = 0;
    const save = await fetch(`${baseUrl}/api/availability`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventDuration: 30, timezone: 'Asia/Tokyo', name: 'Uma', bookingSlug: 'uma', monday: { enabled: true, start: '09:00', end: '17:00' } }),
    });
    assert.equal(save.status, 200);
    assert.match(local().recurrence, /BYDAY=TU/);

    // The Pod copy is updated in the background, in place
    for (let i = 0; i < 50 && local().pod_rule_pending; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(local().pod_rule_pending, 0);
    const ruleWrite = pod.writes.find((w) => w.url === local().pod_url);
    assert.ok(ruleWrite, 'the Pod copy was written');
    assert.match(ruleWrite.body, /BYDAY=TU/);
    assert.doesNotMatch(ruleWrite.method, /DELETE/);
  });

  it('takes the slot on every occurrence, on the public page and for the organizer', async () => {
    const { getBookedSlots, hasOverlappingBooking } = await import('../cloud/models/bookings-db.js');
    const res = await book({ date: MONDAY, time: '10:00', recurrence: { frequency: 'WEEKLY', count: 3 } });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.booking.isRecurring, true);

    const taken = (date) => getBookedSlots('uma', date).map((b) => `${b.start_time}-${b.end_time.slice(11)}`);
    assert.deepEqual(taken('2030-09-16'), ['2030-09-16 10:00-10:30']);
    assert.deepEqual(taken('2030-09-23'), ['2030-09-23 10:00-10:30'], 'second occurrence');
    assert.deepEqual(taken('2030-09-30'), ['2030-09-30 10:00-10:30'], 'third occurrence');
    assert.deepEqual(taken('2030-10-07'), [], 'the series has ended (COUNT=3)');
    assert.deepEqual(taken('2030-09-24'), [], 'other days are free');

    assert.equal(hasOverlappingBooking('uma', '2030-09-23 10:15', '2030-09-23 10:45'), true);
    assert.equal(hasOverlappingBooking('uma', '2030-09-23 10:30', '2030-09-23 11:00'), false);

    // The organizer cannot book over a later occurrence either (checked in the Pod)
    assert.equal((await book({ date: '2030-09-23', time: '10:00' })).status, 409);
    assert.equal((await book({ date: '2030-09-23', time: '11:00' })).status, 201);
  });

  it('lists a series once in upcoming, at its next occurrence', async () => {
    // Began in 2020 and repeats weekly with no end: its next occurrence is within a week
    const start = new Date('2020-01-06T09:00:00Z');
    const solid = (await import('../services/solid.js')).default;
    await solid.saveBooking(POD, {
      id: 'series-old', title: 'Weekly sync', start, end: new Date(start.getTime() + 30 * 60000),
      organizer: { name: 'Uma', email: 'uma@example.com' }, attendee: { name: 'Wes', email: 'wes@example.com' },
      recurrence: { frequency: 'WEEKLY' },
    }, pod.fetch);

    const { bookings } = await get('/api/bookings/upcoming');
    assert.deepEqual(bookings.map((b) => b.id), ['series-old']);
    const next = new Date(bookings[0].start);
    assert.ok(next > new Date() && next - new Date() <= 7 * 24 * 60 * 60 * 1000, bookings[0].start);
    assert.equal(bookings[0].seriesStart, '2020-01-06T09:00:00.000Z');
  });

  it('frees one slot when a single occurrence is cancelled, and keeps the rest', async () => {
    const { getBookedSlots } = await import('../cloud/models/bookings-db.js');
    const created = await (await book({ date: MONDAY, time: '14:00', recurrence: { frequency: 'WEEKLY', count: 3 } })).json();

    const res = await fetch(`${baseUrl}/api/bookings/${created.booking.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      // 14:00 in Paris on 23 September is 12:00 UTC
      body: JSON.stringify({ notify: false, scope: 'single', occurrenceDate: '2030-09-23T12:00:00Z' }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

    assert.equal(getBookedSlots('uma', '2030-09-16').length, 1);
    assert.equal(getBookedSlots('uma', '2030-09-23').length, 0, 'cancelled occurrence is free');
    assert.equal(getBookedSlots('uma', '2030-09-30').length, 1);
  });

  it('accepts "every 2 weeks" as a weekly rule with an interval', async () => {
    const { getBookedSlots } = await import('../cloud/models/bookings-db.js');
    const res = await book({ date: MONDAY, time: '16:00', recurrence: { frequency: 'WEEKLY', interval: 2, count: 2 } });
    assert.equal(res.status, 201);
    assert.equal(getBookedSlots('uma', '2030-09-23').length, 0);
    assert.equal(getBookedSlots('uma', '2030-09-30').length, 1);
    assert.equal((await book({ date: MONDAY, time: '17:00', recurrence: { frequency: 'biweekly' } })).status, 400);
  });
});

describe('editing, cancelled bookings and statistics', () => {
  const book = (body) => fetch(`${baseUrl}/api/bookings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Xan Client', email: 'xan@example.com', ...body }),
  });
  const put = (id, body) => fetch(`${baseUrl}/api/bookings/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  beforeEach(async () => {
    const { saveAvailability } = await import('../cloud/models/bookings-db.js');
    saveAvailability({ eventDuration: 30, timezone: 'Europe/Paris', name: 'Uma' }, 'uma');
    const solid = (await import('../services/solid.js')).default;
    await solid.saveAvailability(POD, { eventDuration: 30, timezone: 'Europe/Paris', name: 'Uma', email: 'uma@example.com', days: {} }, pod.fetch);
  });

  it('changes a one-off booking in the Pod when it is edited', async () => {
    const created = await (await book({ date: '2030-09-16', time: '10:00' })).json();
    pod.writes.length = 0;

    const res = await put(created.booking.id, { title: 'Quarterly review', location: 'Room 4' });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const patches = pod.writes.filter((w) => w.method === 'PATCH' && w.url.endsWith(`${created.booking.id}.ttl`));
    assert.equal(patches.length, 1, 'the booking file is updated in place');
    assert.match(patches[0].body, /Quarterly review/);
    assert.match(patches[0].body, /Room 4/);
  });

  it('rejects an edit with nothing in it, or with text that is not text', async () => {
    const created = await (await book({ date: '2030-09-16', time: '11:00' })).json();
    assert.equal((await put(created.booking.id, {})).status, 400);
    assert.equal((await put(created.booking.id, { title: 'x'.repeat(500) })).status, 400);
    assert.equal((await put(created.booking.id, { location: { nested: true } })).status, 400);
  });

  it('records in the Pod that the confirmation was sent, instead of saving the booking again', async () => {
    const created = await (await book({ date: '2030-09-16', time: '12:00' })).json();
    const writes = pod.writes.filter((w) => w.url.endsWith(`${created.booking.id}.ttl`));
    // One PUT creates the booking. Confirmation status, if the email went out, is a PATCH: never a second PUT.
    assert.equal(writes.filter((w) => w.method === 'PUT').length, 1);
    for (const w of writes.filter((x) => x.method === 'PATCH')) assert.match(w.body, /confirmationSent/);
  });

  it('lists cancelled bookings when asked, and counts them', async () => {
    insert('kept', '2030-09-16 10:00', '2030-09-16 10:30');
    insert('dropped', '2030-09-17 10:00', '2030-09-17 10:30');
    await get('/api/bookings'); // pushes both to the Pod
    const res = await fetch(`${baseUrl}/api/bookings/dropped`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notify: false }),
    });
    assert.equal(res.status, 200);

    assert.deepEqual((await get('/api/bookings')).bookings.map((b) => b.id), ['kept']);
    assert.deepEqual((await get('/api/bookings?status=cancelled')).bookings.map((b) => b.id), ['dropped']);
    assert.deepEqual((await get('/api/bookings?status=all')).bookings.map((b) => b.id), ['kept', 'dropped']);
    assert.equal((await get('/api/bookings/stats')).cancelled, 1);
  });

  it('counts the same things whether statistics come from the Pod or the local copy', async () => {
    // Relative to now, in the account timezone: one meeting later today, one next year, one last year
    const { instantToNaive } = await import('../utils/tz.js');
    const day = (offsetDays) => instantToNaive(new Date(Date.now() + offsetDays * 86400000), 'Europe/Paris').slice(0, 10);
    insert('today', `${day(0)} 23:00`, `${day(0)} 23:30`);
    insert('next-year', `${day(400)} 10:00`, `${day(400)} 10:30`);
    insert('last-year', `${day(-400)} 10:00`, `${day(-400)} 10:30`);

    const fromPod = await get('/api/bookings/stats');
    pod = null; // Solid session lost: the local copy answers
    const fromLocal = await get('/api/bookings/stats');

    assert.equal(fromLocal.source, 'local');
    for (const key of ['thisWeek', 'thisMonth', 'upcoming', 'cancelled']) {
      assert.equal(fromPod[key], fromLocal[key], key);
    }
    assert.equal(fromPod.thisWeek, 1, 'only the meeting taking place this week');
    assert.equal(fromPod.thisMonth, 1);
    assert.ok(fromPod.upcoming >= 1 && fromPod.upcoming <= 2, 'next year, and today unless 23:00 has passed');
  });
});

describe('downloading a booking as .ics from the dashboard', () => {
  const ics = (id) => fetch(`${baseUrl}/api/bookings/${id}/ics`);

  it("serves a visitor's booking that has just been made, in the account's timezone", async () => {
    insert('booking-fresh-ics', '2030-09-16 10:00', '2030-09-16 10:30', { title: 'Intro call' });
    const res = await ics('booking-fresh-ics');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/calendar/);
    assert.match(res.headers.get('content-disposition'), /filename="Intro-call\.ics"/);
    const body = await res.text();
    assert.match(body, /DTSTART;TZID=Europe\/Paris:20300916T100000/);
    assert.match(body, /BEGIN:VTIMEZONE/);
  });

  it('serves the local copy when the Pod cannot be reached', async () => {
    insert('booking-offline-ics', '2030-09-16 11:00', '2030-09-16 11:30');
    pod = null;
    const res = await ics('booking-offline-ics');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /UID:booking-offline-ics/);
  });

  it("answers 404 for an unknown booking or another account's", async () => {
    sqlite.prepare(`INSERT INTO bookings (id, slug, title, start_time, end_time, attendee_name, attendee_email)
      VALUES ('other-ics', 'someone-else', 'Not yours', '2030-09-16 10:00', '2030-09-16 10:30', 'X', 'x@example.com')`).run();
    assert.equal((await ics('no-such-booking')).status, 404);
    assert.equal((await ics('other-ics')).status, 404);
  });
});
