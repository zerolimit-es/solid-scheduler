/**
 * Tenant wiring for the self-hosted build: every signed-in WebID gets a
 * tenant (created on first sign-in), and routes that key on req.tenant work.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-tenants-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DB_ENCRYPTION_KEY;

let ensureTenant, db, express, loadTenant, passkeyRoutes, bookingsRoutes;
let server, baseUrl;

before(async () => {
  ({ ensureTenant } = await import('../cloud/services/tenants.js'));
  db = await import('../cloud/models/database.js');
  express = (await import('express')).default;
  ({ loadTenant } = await import('../cloud/middleware/tierEnforcement.js'));
  passkeyRoutes = (await import('./passkey.js')).default;
  bookingsRoutes = (await import('./bookings.js')).default;

  // Same order as server.js: session → tenant → routes. A plain object stands
  // in for the cookie session; the x-webid header says who is signed in.
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const webId = req.get('x-webid');
    req.session = webId ? { webId } : {};
    next();
  });
  app.use(loadTenant());
  app.get('/whoami', (req, res) => res.json({ tenantId: req.tenant?.id ?? null, slug: req.tenant?.booking_slug ?? null }));
  app.use('/api/auth/passkey', passkeyRoutes);
  app.use('/api/bookings', bookingsRoutes);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  try { db.getDb().close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const get = (p, webId) => fetch(`${baseUrl}${p}`, { headers: webId ? { 'x-webid': webId } : {} });

describe('ensureTenant', () => {
  it('creates a tenant once per WebID', () => {
    const webId = 'https://alice.solidcommunity.net/profile/card#me';
    const first = ensureTenant(webId);
    const second = ensureTenant(webId);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.tenant.id, first.tenant.id);
    assert.equal(first.tenant.webid, webId);
    assert.ok(first.tenant.booking_slug);
  });

  it("claims the slug from the user's Pod when it is free", () => {
    const { tenant } = ensureTenant('https://bob.solidcommunity.net/profile/card#me', { preferredSlug: 'Bob Consulting' });
    assert.equal(tenant.booking_slug, 'bob-consulting');
  });

  it('never takes a slug another tenant holds', () => {
    const { tenant } = ensureTenant('https://mallory.solidcommunity.net/profile/card#me', { preferredSlug: 'bob-consulting' });
    assert.notEqual(tenant.booking_slug, 'bob-consulting');
    assert.equal(db.getTenantBySlug('bob-consulting').webid, 'https://bob.solidcommunity.net/profile/card#me');
  });

  it('handles two WebIDs that derive the same name', () => {
    const a = ensureTenant('https://pod-one.example/damien/profile/card#me').tenant;
    const b = ensureTenant('https://pod-two.example/damien/profile/card#me').tenant;
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.subdomain, b.subdomain);
    assert.notEqual(a.booking_slug, b.booking_slug);
  });
});

describe('loadTenant on signed-in requests', () => {
  it('sets req.tenant for a signed-in WebID, creating it on first request', async () => {
    const webId = 'https://carol.solidcommunity.net/profile/card#me';
    assert.equal(db.getTenantByWebId(webId), undefined);
    const body = await (await get('/whoami', webId)).json();
    assert.ok(body.tenantId);
    assert.equal(db.getTenantByWebId(webId).id, body.tenantId);
  });

  it('leaves anonymous requests without a tenant', async () => {
    assert.deepEqual(await (await get('/whoami')).json(), { tenantId: null, slug: null });
  });

  it('lets a signed-in user start passkey registration', async () => {
    const res = await get('/api/auth/passkey/register-options', 'https://dave.solidcommunity.net/profile/card#me');
    assert.equal(res.status, 200);
    const opts = await res.json();
    assert.ok(opts.challenge, 'registration options include a challenge');
  });

  it('no longer rejects booking cancellation as unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/bookings/does-not-exist`, {
      method: 'DELETE',
      headers: { 'x-webid': 'https://erin.solidcommunity.net/profile/card#me', 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = await res.json().catch(() => ({}));
    assert.notEqual(body.error, 'Authentication required');
  });
});
