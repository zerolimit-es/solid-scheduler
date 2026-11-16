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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-dashboard-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DB_ENCRYPTION_KEY;

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

    state.writes.push({ method, url });
    const body = String(init.body ?? '');
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
