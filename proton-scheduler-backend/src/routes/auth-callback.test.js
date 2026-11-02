/**
 * End-to-end check of the OIDC callback through the real auth router:
 * a login whose issuer is not the WebID's solid:oidcIssuer must end with no
 * authenticated session and a failure redirect.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-auth-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.FRONTEND_URL = 'http://frontend.test';
delete process.env.DB_ENCRYPTION_KEY;

const VICTIM = 'https://victim.example/profile/card#me';
const realFetch = globalThis.fetch;
let server;
let baseUrl;
let sessionManager;

before(async () => {
  const express = (await import('express')).default;
  const cookieSession = (await import('cookie-session')).default;
  ({ sessionManager } = await import('../middleware/auth.js'));
  const { default: authRoutes, rejectedLoginRedirect } = await import('./auth.js');

  // Public WebID profile: the victim trusts only the real IdP.
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://victim.example/')) {
      return new Response(
        `<${VICTIM}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <https://real-idp.example/> .`,
        { headers: { 'Content-Type': 'text/turtle' } }
      );
    }
    return realFetch(url, init);
  };

  // Stand in for the IdP round trip: the token says the user is VICTIM.
  sessionManager.handleCallback = async (session) => {
    session.info.isLoggedIn = true;
    session.info.webId = VICTIM;
    return { isLoggedIn: true, webId: VICTIM, sessionId: session.info.sessionId };
  };
  sessionManager.logout = async (session) => {
    session.info.isLoggedIn = false;
    sessionManager.fetchMap.delete(VICTIM);
  };

  const app = express();
  app.use(cookieSession({ name: 's', secret: 'test-secret' }));
  app.use((req, _res, next) => {
    // Simulate the state left by /login with the chosen issuer, plus any
    // earlier session state the test passes in `prior`.
    if (req.query.prior) Object.assign(req.session, JSON.parse(Buffer.from(req.query.prior, 'base64url').toString()));
    req.session.oidcIssuer = req.query.issuer;
    req.session.solidSessionId = 'sid-1';
    req.solidSession = {
      info: { sessionId: 'sid-1', isLoggedIn: false },
      fetch: async () => { throw new Error('no pod discovery in tests'); },
    };
    next();
  });
  app.use('/api/auth/callback', rejectedLoginRedirect);
  app.use('/api/auth', authRoutes);

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  globalThis.fetch = realFetch;
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function callback(issuer, prior) {
  const priorParam = prior ? `&prior=${Buffer.from(JSON.stringify(prior)).toString('base64url')}` : '';
  const res = await realFetch(
    `${baseUrl}/api/auth/callback?code=x&state=y&issuer=${encodeURIComponent(issuer)}${priorParam}`,
    { redirect: 'manual' }
  );
  const cookie = res.headers.get('set-cookie') || '';
  const match = cookie.match(/(?:^|,\s*)s=([^;]+)/);
  const session = match ? JSON.parse(Buffer.from(match[1], 'base64').toString()) : {};
  return { location: res.headers.get('location'), session };
}

describe('OIDC callback issuer binding', () => {
  it('rejects a token from an issuer the WebID does not trust', async () => {
    const { location, session } = await callback('https://evil-idp.example/');
    const url = new URL(location);
    assert.equal(url.origin, 'http://frontend.test');
    assert.equal(url.searchParams.get('login'), 'failed');
    assert.equal(session.webId, undefined);
    assert.equal(session.solidSessionId, undefined);
    assert.equal(sessionManager.fetchMap.has(VICTIM), false);
    const { getTenantByWebId } = await import('../cloud/models/database.js');
    assert.equal(getTenantByWebId(VICTIM), undefined, 'no tenant for a rejected login');
    assert.equal(session.tenantId, undefined);
  });

  it('accepts the issuer listed in the WebID profile', async () => {
    const { location, session } = await callback('https://real-idp.example');
    assert.equal(new URL(location).searchParams.get('login'), 'success');
    assert.equal(session.webId, VICTIM);
  });

  it('creates the tenant on first sign-in and puts it in the session', async () => {
    const { getTenantByWebId } = await import('../cloud/models/database.js');
    const tenant = getTenantByWebId(VICTIM);
    assert.ok(tenant, 'tenant created by the accepted login');
    const { session } = await callback('https://real-idp.example');
    assert.equal(session.tenantId, tenant.id);
  });
});

describe('MFA skip is bound to the account that passed it (#73)', () => {
  before(async () => {
    // Give the victim a passkey, so sign-in requires the passkey check
    const { getDb, getTenantByWebId } = await import('../cloud/models/database.js');
    const tenant = getTenantByWebId(VICTIM);
    getDb().prepare('INSERT INTO passkeys (id, tenant_id, credential_id, public_key) VALUES (?, ?, ?, ?)')
      .run('pk-victim', tenant.id, 'cred-victim', Buffer.from('k'));
  });

  it("doesn't skip the victim's passkey check after another account passed its own", async () => {
    const { location, session } = await callback('https://real-idp.example', {
      mfaVerifiedWebId: 'https://attacker.example/profile/card#me',
      passkeyVerifiedAt: Date.now(),
      passkeyVerifiedFor: 'attacker-tenant',
    });
    assert.equal(new URL(location).searchParams.get('login'), 'mfa-required');
    assert.equal(session.mfaPending, true);
  });

  it('ignores the old unbound mfaVerified flag', async () => {
    const { location, session } = await callback('https://real-idp.example', { mfaVerified: true });
    assert.equal(new URL(location).searchParams.get('login'), 'mfa-required');
    assert.equal(session.mfaVerified, undefined);
  });

  it('still skips it on a reconnect by the same account', async () => {
    const { location } = await callback('https://real-idp.example', { mfaVerifiedWebId: VICTIM });
    assert.equal(new URL(location).searchParams.get('login'), 'success');
  });
});
