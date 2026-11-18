/**
 * End to end through the real server: a signed-in session must reach routes
 * with a tenant. Before tenants were wired into server.js, every route keyed
 * on req.tenant failed for self-hosters (e.g. passkey registration answered
 * 400 "User not found").
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-e2e-'));
const DB_FILE = path.join(tmpDir, 'e2e.db');
const FRONTEND = 'http://localhost:3000';
let child;
let baseUrl;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

/** Merge Set-Cookie headers from a response into a cookie jar string. */
function updateJar(jar, res) {
  const cookies = Object.fromEntries(jar.split('; ').filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2)));
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [name, value] = pair.split(/=(.*)/s);
    cookies[name] = value;
  }
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/** A cookie-session cookie pair, signed the way keygrip does (HMAC-SHA1, base64url). */
function sessionCookie(session) {
  // A signed-in session carries the ID and sign-in time the server checks
  if (session.webId && !session.sid) session = { sid: crypto.randomUUID(), loginAt: Date.now(), ...session };
  const value = Buffer.from(JSON.stringify(session)).toString('base64');
  const sig = crypto.createHmac('sha1', SECRET).update(`${COOKIE}=${value}`).digest('base64')
    .replace(/\/|\+|=/g, (c) => ({ '/': '_', '+': '-', '=': '' })[c]);
  return `${COOKIE}=${value}; ${COOKIE}.sig=${sig}`;
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DB_PATH: DB_FILE, FRONTEND_URL: FRONTEND,
      SESSION_SECRET: SECRET, NODE_ENV: 'test', REDIS_URL: '', DB_ENCRYPTION_KEY: '' },
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

describe('server.js tenant wiring', () => {
  it('lets a signed-in user start passkey registration', async () => {
    const res = await fetch(`${baseUrl}/api/auth/passkey/register-options`, {
      headers: { Cookie: sessionCookie({ webId: 'https://frank.solidcommunity.net/profile/card#me' }) },
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.challenge);
  });

  it('still refuses anonymous requests', async () => {
    const res = await fetch(`${baseUrl}/api/auth/passkey/register-options`);
    assert.equal(res.status, 401);
  });
});

describe('calendar feed token (#67)', () => {
  const GRACE = 'https://grace.solidcommunity.net/profile/card#me';
  const HEIDI = 'https://heidi.solidcommunity.net/profile/card#me';

  async function feedToken(jar) {
    const res = await fetch(`${baseUrl}/api/calendar/feed-token`, { headers: { Cookie: jar } });
    return { res, body: await res.json(), jar: updateJar(jar, res) };
  }

  it('refuses anonymous requests', async () => {
    assert.equal((await fetch(`${baseUrl}/api/calendar/feed-token`)).status, 401);
  });

  it("gives each user a stable feed URL that serves their own bookings", async () => {
    const jar = sessionCookie({ webId: GRACE });
    const first = await feedToken(jar);
    assert.equal(first.res.status, 200, JSON.stringify(first.body));
    assert.match(first.body.token, /^[0-9a-f]{64}$/);
    assert.equal(first.body.feedPath, `/api/calendar/feed/${first.body.token}.ics`);
    assert.equal((await feedToken(first.jar)).body.token, first.body.token, 'same token on reload');

    // A booking on Grace's booking page shows up in her feed
    const sqlite = new Database(DB_FILE);
    const slug = sqlite.prepare('SELECT booking_slug FROM tenants WHERE webid = ?').get(GRACE).booking_slug;
    const soon = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    sqlite.prepare(`INSERT INTO bookings (id, slug, title, start_time, end_time, attendee_name, attendee_email)
      VALUES ('feed-test-1', ?, 'Feed test meeting', ?, ?, 'Ivan', 'ivan@example.com')`)
      .run(slug, `${soon} 10:00`, `${soon} 10:30`);
    sqlite.close();

    const feed = await fetch(`${baseUrl}${first.body.feedPath}`);
    assert.equal(feed.status, 200);
    assert.match(feed.headers.get('content-type'), /text\/calendar/);
    const ics = await feed.text();
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:Feed test meeting/);
    // Times carry the account's timezone, which the feed defines; the UID
    // matches the emailed invitation for the same booking
    assert.match(ics, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Paris/);
    assert.match(ics, /X-WR-TIMEZONE:Europe\/Paris/);
    assert.match(ics, new RegExp(`DTSTART;TZID=Europe/Paris:${soon.replace(/-/g, '')}T100000`));
    assert.match(ics, /UID:feed-test-1@solidscheduler\.local/);
    // Same feed on the legacy direct-backend path
    assert.equal((await fetch(`${baseUrl}/cal/${first.body.token}.ics`)).status, 200);

    // Another user gets a different feed, without Grace's booking
    const other = await feedToken(sessionCookie({ webId: HEIDI }));
    assert.notEqual(other.body.token, first.body.token);
    const otherIcs = await (await fetch(`${baseUrl}${other.body.feedPath}`)).text();
    assert.doesNotMatch(otherIcs, /Feed test meeting/);
  });

  it('regenerates the URL and retires the old one', async () => {
    let jar = sessionCookie({ webId: GRACE });
    const before = await feedToken(jar);
    jar = before.jar;

    const csrfRes = await fetch(`${baseUrl}/api/csrf-token`, { headers: { Cookie: jar } });
    const { csrfToken } = await csrfRes.json();
    jar = updateJar(jar, csrfRes);

    const res = await fetch(`${baseUrl}/api/calendar/feed-token/regenerate`, {
      method: 'POST',
      headers: { Cookie: jar, 'X-CSRF-Token': csrfToken, Origin: FRONTEND, 'Content-Type': 'application/json' },
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.notEqual(body.token, before.body.token);
    assert.equal((await fetch(`${baseUrl}${before.body.feedPath}`)).status, 404, 'old URL retired');
    assert.equal((await fetch(`${baseUrl}${body.feedPath}`)).status, 200);
  });

  it('rejects regeneration without a CSRF token', async () => {
    const res = await fetch(`${baseUrl}/api/calendar/feed-token/regenerate`, {
      method: 'POST',
      headers: { Cookie: sessionCookie({ webId: GRACE }), Origin: FRONTEND },
    });
    assert.equal(res.status, 403);
  });
});

describe('passkey challenges without Redis (#66)', () => {
  it('keeps the registration challenge until register-verify', async () => {
    let jar = sessionCookie({ webId: 'https://judy.solidcommunity.net/profile/card#me' });
    const opts = await fetch(`${baseUrl}/api/auth/passkey/register-options`, { headers: { Cookie: jar } });
    assert.equal(opts.status, 200);
    jar = updateJar(jar, opts);

    const csrfRes = await fetch(`${baseUrl}/api/csrf-token`, { headers: { Cookie: jar } });
    const { csrfToken } = await csrfRes.json();
    jar = updateJar(jar, csrfRes);

    // A malformed attestation must fail verification, not the challenge lookup.
    const res = await fetch(`${baseUrl}/api/auth/passkey/register-verify`, {
      method: 'POST',
      headers: { Cookie: jar, 'X-CSRF-Token': csrfToken, Origin: FRONTEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: { id: 'x', rawId: 'x', type: 'public-key', response: {} } }),
    });
    const body = await res.json();
    assert.notEqual(body.error, 'Challenge expired or not found — try again');
  });
});

describe('Origin check applies only to requests that carry the session cookie (#74)', () => {
  const booking = (time) => JSON.stringify({ date: '2030-08-20', time, name: 'Script Client', email: 'script@example.com' });
  const post = (time, headers = {}) => fetch(`${baseUrl}/api/public/origin-test/book`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: booking(time),
  });

  // Bookings are only accepted for a booking page an account holds: signing
  // in creates the account, whose slug comes from the WebID ("origin-test").
  before(async () => {
    const res = await fetch(`${baseUrl}/api/auth/status`, {
      headers: { Cookie: sessionCookie({ webId: 'https://origin-test.solidcommunity.net/profile/card#me' }) },
    });
    assert.equal(res.status, 200);
  });

  it('lets a cookieless client book without an Origin header', async () => {
    const res = await post('09:00');
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.success, true);
  });

  it('rejects a cookie-carrying request from a foreign origin', async () => {
    const res = await post('10:00', { Cookie: sessionCookie({ webId: 'https://kim.solidcommunity.net/profile/card#me' }), Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).message, 'Cross-site request rejected');
  });

  it('rejects a cookie-carrying request with no Origin or Referer', async () => {
    const res = await post('11:00', { Cookie: sessionCookie({ webId: 'https://kim.solidcommunity.net/profile/card#me' }) });
    assert.equal(res.status, 403);
  });

  it('accepts a cookie-carrying request from the frontend origin', async () => {
    const res = await post('12:00', { Cookie: sessionCookie({ webId: 'https://kim.solidcommunity.net/profile/card#me' }), Origin: FRONTEND });
    assert.equal(res.status, 201);
  });

  it('treats an anonymous cookie (no signed-in user) as a cookie too', async () => {
    const res = await post('13:00', { Cookie: sessionCookie({ solidSessionId: 'anon' }), Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
  });
});

describe('passkey changes need a recent passkey check (#73)', () => {
  const OWNER = 'https://olivia.solidcommunity.net/profile/card#me';
  let tenantId;
  let otherTenantId;

  before(async () => {
    // Create both tenants, then give OWNER a passkey
    await fetch(`${baseUrl}/whoami-not-a-route`, { headers: { Cookie: sessionCookie({ webId: OWNER }) } });
    await fetch(`${baseUrl}/whoami-not-a-route`, { headers: { Cookie: sessionCookie({ webId: 'https://oscar.solidcommunity.net/profile/card#me' }) } });
    const sqlite = new Database(DB_FILE);
    tenantId = sqlite.prepare('SELECT id FROM tenants WHERE webid = ?').get(OWNER).id;
    otherTenantId = sqlite.prepare('SELECT id FROM tenants WHERE webid = ?').get('https://oscar.solidcommunity.net/profile/card#me').id;
    sqlite.prepare('INSERT INTO passkeys (id, tenant_id, credential_id, public_key, device_name) VALUES (?, ?, ?, ?, ?)')
      .run('pk-olivia', tenantId, 'cred-olivia', Buffer.from('k'), 'Laptop');
    sqlite.close();
  });

  /** A client for OWNER whose session holds `extra` (e.g. a passkey check). */
  async function owner(extra = {}) {
    let jar = sessionCookie({ webId: OWNER, ...extra });
    const csrfRes = await fetch(`${baseUrl}/api/csrf-token`, { headers: { Cookie: jar } });
    const { csrfToken } = await csrfRes.json();
    jar = updateJar(jar, csrfRes);
    return {
      registerOptions: () => fetch(`${baseUrl}/api/auth/passkey/register-options`, { headers: { Cookie: jar } }),
      remove: (id) => fetch(`${baseUrl}/api/auth/passkey/${id}`, {
        method: 'DELETE', headers: { Cookie: jar, Origin: FRONTEND, 'X-CSRF-Token': csrfToken },
      }),
    };
  }

  it('lets an account with no passkeys add its first one without a check', async () => {
    const res = await fetch(`${baseUrl}/api/auth/passkey/register-options`, {
      headers: { Cookie: sessionCookie({ webId: 'https://oscar.solidcommunity.net/profile/card#me' }) },
    });
    assert.equal(res.status, 200);
  });

  it('refuses to add or remove passkeys without a recent check', async () => {
    const c = await owner();
    const add = await c.registerOptions();
    assert.equal(add.status, 403);
    assert.equal((await add.json()).error, 'passkey_reauth_required');
    const del = await c.remove('pk-olivia');
    assert.equal(del.status, 403);
    assert.equal((await del.json()).error, 'passkey_reauth_required');
  });

  it("doesn't accept a check that is too old, or one passed for another account", async () => {
    const stale = await owner({ passkeyVerifiedAt: Date.now() - 6 * 60 * 1000, passkeyVerifiedFor: tenantId });
    assert.equal((await stale.registerOptions()).status, 403);
    const other = await owner({ passkeyVerifiedAt: Date.now(), passkeyVerifiedFor: otherTenantId });
    assert.equal((await other.registerOptions()).status, 403);
  });

  it('allows changes right after a check by this account', async () => {
    const c = await owner({ passkeyVerifiedAt: Date.now(), passkeyVerifiedFor: tenantId });
    assert.equal((await c.registerOptions()).status, 200);
    assert.equal((await c.remove('pk-olivia')).status, 200);
  });
});

describe('booking slug ownership', () => {
  const LEO = 'https://leo.solidcommunity.net/profile/card#me';
  const MIA = 'https://mia.solidcommunity.net/profile/card#me';
  const day = { enabled: true, start: '09:00', end: '17:00' };

  /** A signed-in client: cookie jar + CSRF token, sending the frontend Origin. */
  async function signIn(webId) {
    let jar = sessionCookie({ webId });
    const csrfRes = await fetch(`${baseUrl}/api/csrf-token`, { headers: { Cookie: jar } });
    const { csrfToken } = await csrfRes.json();
    jar = updateJar(jar, csrfRes);
    return (path, options = {}) => fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { Cookie: jar, Origin: FRONTEND, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
    });
  }
  const saveSlug = (client, bookingSlug) => client('/api/availability', {
    method: 'PUT', body: JSON.stringify({ eventDuration: 30, bookingSlug, monday: day }),
  });
  const book = (slug, time) => fetch(`${baseUrl}/api/public/${slug}/book`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2030-09-02', time, name: 'Nia Visitor', email: 'nia@example.com' }),
  });
  const bookingCount = async (client) => (await (await client('/api/bookings')).json()).count;

  it('refuses bookings for a slug no account holds', async () => {
    const res = await book('nobody-holds-this', '09:00');
    assert.equal(res.status, 404);
    const sqlite = new Database(DB_FILE);
    const rows = sqlite.prepare("SELECT COUNT(*) AS c FROM bookings WHERE slug = 'nobody-holds-this'").get().c;
    sqlite.close();
    assert.equal(rows, 0);
  });

  it('keeps bookings with the account when its slug changes, and out of reach of the next holder', async () => {
    const leo = await signIn(LEO);
    assert.equal((await saveSlug(leo, 'leo-page')).status, 200);
    assert.equal((await book('leo-page', '09:00')).status, 201);
    assert.equal((await book('leo-page', '10:00')).status, 201);
    assert.equal(await bookingCount(leo), 2);

    assert.equal((await saveSlug(leo, 'leo-renamed')).status, 200);
    assert.equal(await bookingCount(leo), 2, 'bookings follow the rename');

    // The old slug is free again, and comes with nothing of Leo's
    const mia = await signIn(MIA);
    assert.equal((await saveSlug(mia, 'leo-page')).status, 200);
    assert.equal(await bookingCount(mia), 0);
    assert.equal(await bookingCount(leo), 2);

    // The saved availability moved too
    const avail = await (await fetch(`${baseUrl}/api/public/leo-renamed/availability`)).json();
    assert.equal(avail.monday.enabled, true);
  });

  it("refuses a slug held by another account, or one with someone else's leftover data", async () => {
    const mia = await signIn(MIA);
    assert.equal((await saveSlug(mia, 'leo-renamed')).status, 409);

    // Rows left under an unheld slug (e.g. by a rename before this fix)
    const sqlite = new Database(DB_FILE);
    sqlite.prepare(`INSERT INTO bookings (id, slug, title, start_time, end_time, attendee_name, attendee_email)
      VALUES ('orphan-1', 'orphaned-page', 'Old meeting', '2030-09-03 09:00', '2030-09-03 09:30', 'Omar', 'omar@example.com')`).run();
    sqlite.close();
    assert.equal((await saveSlug(mia, 'orphaned-page')).status, 409);
    assert.equal(await bookingCount(mia), 0);
  });

  it('normalises a new booking link, returns it, and lists it with the settings', async () => {
    const leo = await signIn(LEO);
    const res = await saveSlug(leo, 'Leo Meetings!');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).bookingSlug, 'leo-meetings');
    const avail = await (await leo('/api/availability')).json();
    assert.equal(avail.availability.bookingSlug, 'leo-meetings');
  });

  it('refuses a booking link with no letters or digits, and keeps the old one', async () => {
    const leo = await signIn(LEO);
    const res = await saveSlug(leo, '!!!');
    assert.equal(res.status, 400);
    const avail = await (await leo('/api/availability')).json();
    assert.equal(avail.availability.bookingSlug, 'leo-meetings');
  });

  it('gives a new account its booking link before anything is saved', async () => {
    const nora = await signIn('https://nora.solidcommunity.net/profile/card#me');
    const avail = await (await nora('/api/availability')).json();
    assert.equal(avail.configured, false);
    assert.ok(avail.bookingSlug, 'the account already has a booking link');
  });

  it("marks a slot taken in the organizer's own view when a booking overlaps it", async () => {
    const pia = await signIn('https://pia.solidcommunity.net/profile/card#me');
    const save = (eventDuration) => pia('/api/availability', {
      method: 'PUT', body: JSON.stringify({ eventDuration, bookingSlug: 'pia-page', monday: day }),
    });
    assert.equal((await save(30)).status, 200);
    assert.equal((await book('pia-page', '09:30')).status, 201); // 09:30–10:00
    assert.equal((await save(45)).status, 200);

    const own = await (await pia('/api/availability/slots?date=2030-09-02')).json();
    const pub = await (await fetch(`${baseUrl}/api/public/pia-page/slots?date=2030-09-02`)).json();
    const taken = (list) => list.slots.filter((x) => x.isBooked).map((x) => x.time);
    assert.deepEqual(taken(own), ['09:00', '09:45'], '09:00–09:45 and 09:45–10:30 both overlap 09:30–10:00');
    assert.deepEqual(own, pub, 'the same slots as the public page');
  });

  it("offers nothing on past days in the organizer's own view, and checks the date", async () => {
    const pia = await signIn('https://pia.solidcommunity.net/profile/card#me');
    const past = await (await pia('/api/availability/slots?date=2020-01-06')).json();
    assert.deepEqual(past.slots, []);
    assert.equal((await pia('/api/availability/slots?date=2030-02-30')).status, 400);
    assert.equal((await pia('/api/availability/slots?date=tomorrow')).status, 400);
  });

  it('moves stored bookings and blocked time to the new timezone, keeping their moment', async () => {
    const tia = await signIn('https://tia.solidcommunity.net/profile/card#me');
    const save = (timezone) => tia('/api/availability', {
      method: 'PUT', body: JSON.stringify({ eventDuration: 30, bookingSlug: 'tia-page', timezone, monday: day }),
    });
    assert.equal((await save('Europe/Paris')).status, 200);
    assert.equal((await book('tia-page', '09:00')).status, 201); // Monday 2 Sept 2030, 09:00 Paris

    const sqlite = new Database(DB_FILE);
    const tenantId = sqlite.prepare("SELECT id FROM tenants WHERE booking_slug = 'tia-page'").get().id;
    sqlite.prepare(`INSERT INTO bookings (id, slug, title, start_time, end_time, attendee_name, attendee_email, recurrence, excluded_dates)
      VALUES ('tia-series', 'tia-page', 'Weekly', '2030-09-02 20:00', '2030-09-02 20:30', 'Rae', 'rae@example.com', 'FREQ=WEEKLY;BYDAY=MO', '2030-09-09')`).run();
    sqlite.prepare(`INSERT INTO calendar_events (id, tenant_id, title, start_time, end_time, all_day)
      VALUES ('tia-block', ?, 'Dentist', '2030-09-03 14:00', '2030-09-03 15:00', 0),
             ('tia-day', ?, 'Holiday', '2030-09-05 00:00', '2030-09-06 00:00', 1)`).run(tenantId, tenantId);
    sqlite.prepare(`INSERT INTO calendar_events (id, tenant_id, title, start_time, end_time, all_day, recurrence, synced_to_pod, pod_url)
      VALUES ('tia-gym', ?, 'Gym', '2030-09-02 21:00', '2030-09-02 22:00', 0, 'FREQ=WEEKLY;BYDAY=MO', 1, 'https://pod.example/tia/gym.ttl')`).run(tenantId);
    sqlite.close();

    assert.equal((await save('Asia/Tokyo')).status, 200);

    const after = new Database(DB_FILE);
    const one = after.prepare("SELECT start_time, end_time FROM bookings WHERE slug = 'tia-page' AND recurrence IS NULL").get();
    const series = after.prepare("SELECT start_time, recurrence, excluded_dates FROM bookings WHERE id = 'tia-series'").get();
    const block = after.prepare("SELECT start_time, end_time FROM calendar_events WHERE id = 'tia-block'").get();
    const allDay = after.prepare("SELECT start_time FROM calendar_events WHERE id = 'tia-day'").get();
    after.close();
    // Paris is UTC+2 in September, Tokyo UTC+9
    assert.deepEqual({ ...one }, { start_time: '2030-09-02 16:00', end_time: '2030-09-02 16:30' });
    assert.deepEqual({ ...series }, { start_time: '2030-09-03 03:00', recurrence: 'FREQ=WEEKLY;BYDAY=TU', excluded_dates: '2030-09-10' });
    assert.deepEqual({ ...block }, { start_time: '2030-09-03 21:00', end_time: '2030-09-03 22:00' });
    assert.equal(allDay.start_time, '2030-09-05 00:00', 'all-day blocked time stays on its dates');
    const gym = new Database(DB_FILE);
    const gymRow = gym.prepare("SELECT recurrence, synced_to_pod FROM calendar_events WHERE id = 'tia-gym'").get();
    gym.close();
    assert.deepEqual({ ...gymRow }, { recurrence: 'FREQ=WEEKLY;BYDAY=TU', synced_to_pod: 0 }, 'its Pod copy is replaced at the next sync');

    // Saving again with the same timezone moves nothing
    assert.equal((await save('Asia/Tokyo')).status, 200);
    const again = new Database(DB_FILE);
    assert.equal(again.prepare("SELECT start_time FROM bookings WHERE id = 'tia-series'").get().start_time, '2030-09-03 03:00');
    again.close();
  });
});

