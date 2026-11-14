/**
 * End to end through the real server: session lifetime and sign-out,
 * what a pending passkey check allows, Pod URL hosts, request validation,
 * and whose name a booking carries.
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
const PIA = 'https://pia.solidcommunity.net/profile/card#me';
const HOUR = 60 * 60 * 1000;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-hardening-'));
let child;
let baseUrl;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

/** A cookie-session cookie, signed the way keygrip does. The session is sent exactly as given. */
function rawCookie(session) {
  const value = Buffer.from(JSON.stringify(session)).toString('base64');
  const sig = crypto.createHmac('sha1', SECRET).update(`${COOKIE}=${value}`).digest('base64')
    .replace(/\/|\+|=/g, (c) => ({ '/': '_', '+': '-', '=': '' })[c]);
  return `${COOKIE}=${value}; ${COOKIE}.sig=${sig}`;
}
const signedIn = (extra = {}) => ({ webId: PIA, sid: crypto.randomUUID(), loginAt: Date.now(), ...extra });

const isLoggedIn = async (cookie) =>
  (await (await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } })).json()).isLoggedIn;

/** A client for one session: fetches a CSRF token, keeps the cookies the server sets. */
async function client(session) {
  const cookies = Object.fromEntries(rawCookie(session).split('; ').map((c) => c.split(/=(.*)/s).slice(0, 2)));
  const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [name, value] = line.split(';')[0].split(/=(.*)/s);
      cookies[name] = value;
    }
    return res;
  };
  const csrfRes = keep(await fetch(`${baseUrl}/api/csrf-token`, { headers: { Cookie: jar() } }));
  const { csrfToken } = await csrfRes.json();
  const send = async (urlPath, options = {}) => keep(await fetch(`${baseUrl}${urlPath}`, {
    ...options,
    headers: { Cookie: jar(), Origin: FRONTEND, 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
  }));
  send.cookie = jar;
  return send;
}
const json = (method, body) => ({ method, body: JSON.stringify(body) });

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(tmpDir, 'e2e.db'), FRONTEND_URL: FRONTEND,
      SESSION_SECRET: SECRET, NODE_ENV: 'test', REDIS_URL: '', DB_ENCRYPTION_KEY: '',
      ORGANIZER_NAME: 'Instance Default', ALLOW_PRIVATE_POD_HOSTS: '' },
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

describe('sessions end on the server, not just in the browser', () => {
  it('accepts a current session', async () => {
    assert.equal(await isLoggedIn(rawCookie(signedIn())), true);
  });

  it('refuses a session older than 24 hours, or dated in the future', async () => {
    assert.equal(await isLoggedIn(rawCookie(signedIn({ loginAt: Date.now() - 25 * HOUR }))), false);
    assert.equal(await isLoggedIn(rawCookie(signedIn({ loginAt: Date.now() + 2 * HOUR }))), false);
  });

  it('refuses a signed-in cookie with no session ID or sign-in time', async () => {
    assert.equal(await isLoggedIn(rawCookie({ webId: PIA })), false);
    assert.equal(await isLoggedIn(rawCookie({ webId: PIA, loginAt: Date.now() })), false);
  });

  it('stops honouring a copy of the cookie once its owner signs out', async () => {
    const session = signedIn();
    const stolenCopy = rawCookie(session);
    assert.equal(await isLoggedIn(stolenCopy), true);

    const owner = await client(session);
    assert.equal((await owner('/api/auth/logout', { method: 'POST' })).status, 200);

    assert.equal(await isLoggedIn(stolenCopy), false);
    const res = await fetch(`${baseUrl}/api/bookings`, { headers: { Cookie: stolenCopy } });
    assert.equal(res.status, 401);
    // Other sessions of the same account are untouched
    assert.equal(await isLoggedIn(rawCookie(signedIn())), true);
  });
});

describe('Pod URL set by hand', () => {
  const setPodUrl = async (send, podUrl) => send('/api/auth/pod-url', json('PUT', { podUrl }));

  it('is refused while a passkey check is pending', async () => {
    const pending = await client(signedIn({ mfaPending: true }));
    assert.equal((await setPodUrl(pending, 'https://93.184.216.34/pia/')).status, 403);
  });

  it('is refused for hosts inside the server\'s own network', async () => {
    const pia = await client(signedIn());
    for (const url of ['https://127.0.0.1/', 'https://localhost/', 'https://[::1]/', 'https://10.0.0.8/pod/',
      'https://192.168.1.10/', 'https://169.254.169.254/latest/', 'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/']) {
      const res = await setPodUrl(pia, url);
      assert.equal(res.status, 400, url);
    }
  });

  it('is accepted for a public host', async () => {
    const pia = await client(signedIn());
    const res = await setPodUrl(pia, 'https://93.184.216.34/pia');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).podUrl, 'https://93.184.216.34/pia/');
  });
});

describe('request validation on signed-in routes', () => {
  const day = { enabled: true, start: '09:00', end: '17:00' };

  it('rejects availability with an unknown timezone, impossible hours or a bad name', async () => {
    const pia = await client(signedIn());
    const save = (body) => pia('/api/availability', json('PUT', { eventDuration: 30, ...body }));
    assert.equal((await save({ timezone: 'Mars/Olympus' })).status, 400);
    assert.equal((await save({ monday: { enabled: true, start: '25:00', end: '26:00' } })).status, 400);
    assert.equal((await save({ monday: { enabled: true, start: '17:00', end: '09:00' } })).status, 400);
    assert.equal((await save({ organizerName: 'Pia\r\nBcc: x@example.com' })).status, 400);
    assert.equal((await save({ eventDuration: 1 })).status, 400);
    assert.equal((await save({ timezone: 'Europe/Paris', monday: day, organizerName: 'Pia Petit' })).status, 200);
  });

  it('rejects a dashboard booking with an invalid attendee or time', async () => {
    const pia = await client(signedIn());
    const book = (body) => pia('/api/bookings', json('POST', body));
    const good = { date: '2030-09-16', time: '09:00', name: 'Quinn', email: 'quinn@example.com' };
    assert.equal((await book({ ...good, name: 'Quinn\r\nBcc: x@example.com' })).status, 400);
    assert.equal((await book({ ...good, email: 'not-an-email' })).status, 400);
    assert.equal((await book({ ...good, date: '2030-13-45' })).status, 400);
    assert.equal((await book({ start: 'yesterday-ish', end: '2030-09-16T10:00:00Z', attendee: { name: 'Quinn', email: 'quinn@example.com' } })).status, 400);
    assert.equal((await book(good)).status, 201);
  });
});

describe('a booking carries the name of the account it is with', () => {
  it('uses the name saved in the account, not the instance-wide default', async () => {
    // Pia saved "Pia Petit" above; ORGANIZER_NAME is "Instance Default"
    const res = await fetch(`${baseUrl}/api/public/pia/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2030-09-16', time: '11:00', name: 'Rui Visitor', email: 'rui@example.com' }),
    });
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.booking.title, 'Meeting - Rui Visitor & Pia Petit');
    assert.match(body.icsContent, /SUMMARY:Meeting - Rui Visitor & Pia Petit/);
    assert.match(body.icsContent, /ORGANIZER;CN=Pia Petit:/);
  });

  it('falls back to the instance default for an account with no saved name', async () => {
    const SAM = 'https://sam.solidcommunity.net/profile/card#me';
    await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: rawCookie({ ...signedIn(), webId: SAM }) } });
    const res = await fetch(`${baseUrl}/api/public/sam/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2030-09-16', time: '11:00', name: 'Rui Visitor', email: 'rui@example.com' }),
    });
    assert.equal((await res.json()).booking.title, 'Meeting - Rui Visitor & Instance Default');
  });
});
