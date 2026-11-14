import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, checkPublicUrl } from './public-host.js';

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
