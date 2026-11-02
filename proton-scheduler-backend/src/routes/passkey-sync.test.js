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

let getDb, requireOwnCredential, getUnsyncedBookings, syncBookingsToPod, initBookingsTable;

before(async () => {
  ({ getDb } = await import('../cloud/models/database.js'));
  ({ requireOwnCredential } = await import('./passkey.js'));
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

function runGuard(req) {
  let status = null;
  let body = null;
  let nextCalled = false;
  const res = {
    status(code) { status = code; return this; },
    json(b) { body = b; return this; },
  };
  requireOwnCredential(req, res, () => { nextCalled = true; });
  return { status, body, nextCalled };
}

describe('passkey auth-verify ownership guard', () => {
  it("rejects another account's passkey", () => {
    const r = runGuard({ session: { tenantId: 'tenant-alice' }, body: { body: { id: 'cred-mallory' } } });
    assert.equal(r.nextCalled, false);
    assert.equal(r.status, 400);
  });

  it('rejects an unknown credential', () => {
    const r = runGuard({ session: { tenantId: 'tenant-alice' }, body: { body: { id: 'nope' } } });
    assert.equal(r.nextCalled, false);
  });

  it("passes the account's own passkey through", () => {
    const r = runGuard({ tenant: { id: 'tenant-alice' }, body: { body: { id: 'cred-alice' } } });
    assert.equal(r.nextCalled, true);
    assert.equal(r.status, null);
  });

  it('leaves malformed requests to the router', () => {
    assert.equal(runGuard({ session: {}, body: { body: { id: 'cred-alice' } } }).nextCalled, true);
    assert.equal(runGuard({ session: { tenantId: 'tenant-alice' }, body: {} }).nextCalled, true);
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
