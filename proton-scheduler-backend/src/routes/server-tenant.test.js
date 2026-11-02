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
