/**
 * Regression tests for cross-account access:
 *  - passkey MFA must only accept the verified account's own credential
 *  - login sync must only push the logging-in account's bookings to its Pod
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DB_ENCRYPTION_KEY;

let getDb, getUnsyncedBookings, syncBookingsToPod, initBookingsTable;

before(async () => {
  ({ getDb } = await import('../cloud/models/database.js'));
  ({ getUnsyncedBookings, initBookingsTable } = await import('../cloud/models/bookings-db.js'));
  ({ syncBookingsToPod } = await import('../cloud/services/pod-sync.js'));

  const db = getDb();
  initBookingsTable();
  const tenant = db.prepare('INSERT INTO tenants (id, email) VALUES (?, ?)');
  tenant.run('tenant-alice', 'alice@example.com');
  tenant.run('tenant-mallory', 'mallory@example.com');
  const pk = db.prepare(
    'INSERT INTO passkeys (id, tenant_id, credential_id, public_key) VALUES (?, ?, ?, ?)'
  );
  pk.run('pk-alice', 'tenant-alice', 'cred-alice', Buffer.from('a'));
  pk.run('pk-mallory', 'tenant-mallory', 'cred-mallory', Buffer.from('m'));

  const booking = db.prepare(`INSERT INTO bookings
    (id, slug, title, start_time, end_time, attendee_name, attendee_email)
    VALUES (?, ?, ?, '2030-01-01 09:00', '2030-01-01 09:30', ?, ?)`);
  booking.run('b-alice', 'alice', 'Alice meeting', 'Ann', 'ann@example.com');
  booking.run('b-bob', 'bob', 'Bob meeting', 'Private Person', 'private@example.com');
});

after(() => {
  try { getDb().close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * The passkey routes as server.js mounts them, with a plain object standing
 * in for the cookie session of the account in the x-tenant header.
 */
async function passkeyApp() {
  const express = (await import('express')).default;
  const passkeyRoutes = (await import('./passkey.js')).default;
  const sessions = new Map();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const tenantId = req.get('x-tenant');
    if (!sessions.has(tenantId)) sessions.set(tenantId, { webId: `https://${tenantId}.example/#me`, tenantId });
    req.session = sessions.get(tenantId);
    next();
  });
  app.use('/api/auth/passkey', passkeyRoutes);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}`, sessions };
}

describe('passkey auth-verify only accepts the account\'s own credential', () => {
  let app;
  before(async () => { app = await passkeyApp(); });
  after(() => app.server.close());

  /** Start a passkey check as `tenantId`, then answer it with `credentialId`. */
  async function verifyWith(tenantId, credentialId) {
    const headers = { 'x-tenant': tenantId, 'Content-Type': 'application/json' };
    const options = await fetch(`${app.baseUrl}/api/auth/passkey/auth-options`, { headers });
    assert.equal(options.status, 200);
    const res = await fetch(`${app.baseUrl}/api/auth/passkey/auth-verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body: { id: credentialId, rawId: credentialId, type: 'public-key', response: {} } }),
    });
    return { status: res.status, body: await res.json() };
  }

  it("rejects another account's passkey before verifying anything", async () => {
    app.sessions.set('tenant-alice', { webId: 'https://alice.example/#me', tenantId: 'tenant-alice', mfaPending: true });
    const r = await verifyWith('tenant-alice', 'cred-mallory');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Passkey not found');
    assert.equal(app.sessions.get('tenant-alice').mfaPending, true, 'the passkey check is still pending');
  });

  it('rejects an unknown credential', async () => {
    const r = await verifyWith('tenant-alice', 'nope');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Passkey not found');
  });

  it("gets as far as verifying the account's own passkey", async () => {
    // A made-up assertion cannot verify, but it must fail there, not at the ownership check
    const r = await verifyWith('tenant-alice', 'cred-alice');
    assert.notEqual(r.body.error, 'Passkey not found');
    assert.equal(app.sessions.get('tenant-alice').mfaPending, true);
  });
});

describe('booking sync scoping', () => {
  it('getUnsyncedBookings requires a slug', () => {
    assert.throws(() => getUnsyncedBookings(null));
    assert.throws(() => getUnsyncedBookings(undefined));
    assert.throws(() => getUnsyncedBookings(''));
  });

  it("returns only that slug's bookings", () => {
    assert.deepEqual(getUnsyncedBookings('alice').map((b) => b.id), ['b-alice']);
  });

  it('does nothing without a slug', async () => {
    let called = false;
    const fetch = async () => { called = true; throw new Error('no'); };
    const r = await syncBookingsToPod('https://alice.example/pod/', fetch, undefined);
    assert.deepEqual(r, { synced: 0, failed: 0, total: 0 });
    assert.equal(called, false);
  });

  it("never writes other accounts' bookings to the Pod", async () => {
    const bodies = [];
    const fetch = async (url, init = {}) => {
      if (init.body) bodies.push(String(init.body));
      throw new Error('offline');
    };
    const r = await syncBookingsToPod('https://alice.example/pod/', fetch, 'alice');
    assert.equal(r.synced + r.failed, 1);
    assert.ok(!bodies.some((b) => b.includes('private@example.com')));
    // Bob's booking stays unsynced for Bob's own next login
    assert.equal(getUnsyncedBookings('bob').length, 1);
  });
});
