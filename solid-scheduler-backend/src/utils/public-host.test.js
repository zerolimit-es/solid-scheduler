import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, checkPublicUrl, createHostPolicy, NonPublicHostError } from './public-host.js';

describe('isPublicAddress', () => {
  it('accepts public addresses', () => {
    for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) {
      assert.equal(isPublicAddress(a), true, a);
    }
  });

  it('rejects loopback, private, link-local and other non-public addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fd12::1', 'fe80::1', 'ff02::1',
      '::ffff:10.0.0.1', '::ffff:7f00:1', 'not-an-address']) {
      assert.equal(isPublicAddress(a), false, a);
    }
  });
});

describe('checkPublicUrl', () => {
  const resolvesTo = (...addresses) => async () => addresses.map((address) => ({ address }));

  it('accepts a host that resolves only to public addresses', async () => {
    assert.deepEqual(await checkPublicUrl('https://pod.example/alice/', { lookup: resolvesTo('93.184.216.34') }), { ok: true });
  });

  it('rejects a public-looking name that resolves to a private address', async () => {
    const mixed = await checkPublicUrl('https://pod.example/', { lookup: resolvesTo('93.184.216.34', '10.0.0.5') });
    assert.equal(mixed.ok, false);
    assert.equal((await checkPublicUrl('https://internal.example/', { lookup: resolvesTo('127.0.0.1') })).ok, false);
  });

  it('rejects hosts that cannot be resolved, and things that are not URLs', async () => {
    const failing = async () => { throw new Error('ENOTFOUND'); };
    assert.equal((await checkPublicUrl('https://nowhere.example/', { lookup: failing })).ok, false);
    assert.equal((await checkPublicUrl('https://empty.example/', { lookup: resolvesTo() })).ok, false);
    assert.equal((await checkPublicUrl('not a url')).ok, false);
  });
});

describe('createHostPolicy', () => {
  const lookup = async (host) => [{ address: host.startsWith('internal') ? '10.0.0.5' : '93.184.216.34' }];
  const ok = (status = 200, headers = {}) => ({ status, headers: new Headers(headers) });

  it('allows public hosts and refuses private ones', async () => {
    const policy = createHostPolicy({ lookup });
    assert.equal(await policy.isAllowed('https://pod.example/'), true);
    assert.equal(await policy.isAllowed('http://internal.example/'), false);
    assert.equal(await policy.isAllowed('http://169.254.169.254/latest/'), false);
    assert.equal(await policy.isAllowed('file:///etc/passwd'), false);
  });

  it('always allows the operator-configured hosts', async () => {
    const policy = createHostPolicy({ lookup, trustedUrls: ['http://internal.example:3000/'] });
    assert.equal(await policy.isAllowed('http://internal.example:3000/alice/profile/card#me'), true);
    assert.equal(await policy.isAllowed('http://internal.example:8080/'), false);
  });

  it('allows everything when private hosts are allowed', async () => {
    const policy = createHostPolicy({ lookup, allowPrivate: true });
    assert.equal(await policy.isAllowed('http://10.0.0.1/'), true);
  });

  it('filters a Pod list', async () => {
    const policy = createHostPolicy({ lookup });
    assert.deepEqual(
      await policy.filterAllowed(['http://internal.example/', 'https://pod.example/alice/', 'http://127.0.0.1/']),
      ['https://pod.example/alice/'],
    );
  });

  it('refuses to fetch a private address', async () => {
    const calls = [];
    const fetch = createHostPolicy({ lookup }).guardFetch(async (url) => { calls.push(url); return ok(); });
    await assert.rejects(fetch('http://169.254.169.254/latest/meta-data/'), NonPublicHostError);
    assert.deepEqual(calls, []);
  });

  it('follows redirects itself and refuses one to a private address', async () => {
    const calls = [];
    const fetch = createHostPolicy({ lookup }).guardFetch(async (url, init) => {
      calls.push([url, init.redirect]);
      return url === 'https://pod.example/a' ? ok(302, { location: 'http://internal.example/secret' }) : ok();
    });
    await assert.rejects(fetch('https://pod.example/a'), NonPublicHostError);
    assert.deepEqual(calls, [['https://pod.example/a', 'manual']]);
  });

  it('follows a redirect between public hosts, turning a 303 into a GET', async () => {
    const calls = [];
    const fetch = createHostPolicy({ lookup }).guardFetch(async (url, init) => {
      calls.push([url, init.method, init.body]);
      return url === 'https://pod.example/a' ? ok(303, { location: '/b' }) : ok(200);
    });
    const response = await fetch('https://pod.example/a', { method: 'POST', body: 'x' });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [['https://pod.example/a', 'POST', 'x'], ['https://pod.example/b', 'GET', undefined]]);
  });

  it('passes a redirect through when the caller asked for manual redirects', async () => {
    const fetch = createHostPolicy({ lookup }).guardFetch(async () => ok(302, { location: 'http://internal.example/' }));
    const response = await fetch('https://pod.example/a', { redirect: 'manual' });
    assert.equal(response.status, 302);
  });
});
