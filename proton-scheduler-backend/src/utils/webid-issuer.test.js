import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebIdIssuer, normalizeIssuer } from './webid-issuer.js';

const WEBID = 'https://alice.example/profile/card#me';

function profileFetch(turtle, { status = 200 } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(turtle, {
      status,
      headers: { 'Content-Type': 'text/turtle' },
    });
  };
  return { fetch, calls };
}

const profileWith = (...issuers) => `
@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<${WEBID}> a <http://xmlns.com/foaf/0.1/Person>${issuers.map((i) => ` ;\n  solid:oidcIssuer <${i}>`).join('')} .
`;

describe('verifyWebIdIssuer', () => {
  it('accepts an issuer listed in the WebID profile', async () => {
    const { fetch, calls } = profileFetch(profileWith('https://login.inrupt.com'));
    const res = await verifyWebIdIssuer(WEBID, 'https://login.inrupt.com/', { fetch });
    assert.deepEqual(res, { ok: true });
    // fetched the profile document, without the fragment, and unauthenticated
    assert.equal(calls[0].url, 'https://alice.example/profile/card');
    assert.equal(calls[0].init.headers?.Authorization, undefined);
  });

  it('accepts any one of several listed issuers', async () => {
    const { fetch } = profileFetch(profileWith('https://idp-a.example/', 'https://idp-b.example/'));
    assert.equal((await verifyWebIdIssuer(WEBID, 'https://idp-b.example', { fetch })).ok, true);
  });

  it('rejects an attacker issuer not listed in the profile', async () => {
    const { fetch } = profileFetch(profileWith('https://login.inrupt.com/'));
    const res = await verifyWebIdIssuer(WEBID, 'https://evil-idp.example/', { fetch });
    assert.equal(res.ok, false);
  });

  it('rejects a lookalike issuer', async () => {
    const { fetch } = profileFetch(profileWith('https://login.inrupt.com/'));
    for (const lookalike of ['https://login.inrupt.com.evil.example/', 'http://login.inrupt.com/', 'https://login.inrupt.com/evil']) {
      assert.equal((await verifyWebIdIssuer(WEBID, lookalike, { fetch })).ok, false, lookalike);
    }
  });

  it('rejects when the profile lists no issuer', async () => {
    const { fetch } = profileFetch(profileWith());
    assert.equal((await verifyWebIdIssuer(WEBID, 'https://login.inrupt.com/', { fetch })).ok, false);
  });

  it('ignores issuers asserted about a different subject', async () => {
    const turtle = `@prefix solid: <http://www.w3.org/ns/solid/terms#> .
<https://alice.example/profile/card#someone-else> solid:oidcIssuer <https://evil-idp.example/> .
<${WEBID}> solid:oidcIssuer <https://login.inrupt.com/> .`;
    const { fetch } = profileFetch(turtle);
    assert.equal((await verifyWebIdIssuer(WEBID, 'https://evil-idp.example/', { fetch })).ok, false);
  });

  it('fails closed when the profile cannot be fetched', async () => {
    const { fetch } = profileFetch('not found', { status: 404 });
    assert.equal((await verifyWebIdIssuer(WEBID, 'https://login.inrupt.com/', { fetch })).ok, false);
    const throwing = async () => { throw new Error('network down'); };
    assert.equal((await verifyWebIdIssuer(WEBID, 'https://login.inrupt.com/', { fetch: throwing })).ok, false);
  });

  it('fails closed on missing or invalid input without fetching', async () => {
    let called = false;
    const fetch = async () => { called = true; throw new Error('should not fetch'); };
    assert.equal((await verifyWebIdIssuer(WEBID, undefined, { fetch })).ok, false);
    assert.equal((await verifyWebIdIssuer('file:///etc/passwd', 'https://login.inrupt.com/', { fetch })).ok, false);
    assert.equal((await verifyWebIdIssuer('nonsense', 'https://login.inrupt.com/', { fetch })).ok, false);
    assert.equal(called, false);
  });
});

describe('normalizeIssuer', () => {
  it('ignores trailing slashes and rejects non-http URLs', () => {
    assert.equal(normalizeIssuer('https://idp.example/'), normalizeIssuer('https://idp.example'));
    assert.equal(normalizeIssuer('ftp://idp.example/'), null);
  });
});
