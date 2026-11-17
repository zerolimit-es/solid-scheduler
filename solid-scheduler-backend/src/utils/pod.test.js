import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectPod, normalizePodUrl, PodNotAllowedError } from './pod.js';

const pods = ['https://alice.example/pod/', 'https://storage.example/alice/'];

describe('selectPod', () => {
  it('defaults to the first own Pod when none is requested', () => {
    assert.equal(selectPod(undefined, pods), pods[0]);
    assert.equal(selectPod('', pods), pods[0]);
    assert.equal(selectPod(undefined, []), undefined);
  });

  it('accepts a requested Pod that is one of the user\'s own', () => {
    assert.equal(selectPod('https://storage.example/alice/', pods), pods[1]);
    // trailing slash / fragment / query differences are tolerated
    assert.equal(selectPod('https://storage.example/alice', pods), pods[1]);
    assert.equal(selectPod('https://STORAGE.example/alice/#x', pods), pods[1]);
  });

  it('rejects any other Pod URL (SSRF / data swap)', () => {
    for (const bad of [
      'https://attacker.example/',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:6379/',
      'https://alice.example/pod/../../other/',
      'https://alice.example/pod/sub/',
      'https://user:pw@alice.example/pod/',
      'file:///etc/passwd',
      'not a url',
      ['https://alice.example/pod/'],
    ]) {
      assert.throws(() => selectPod(bad, pods), PodNotAllowedError, String(bad));
    }
  });

  it('rejects a requested Pod when the user has no Pods', () => {
    assert.throws(() => selectPod('https://attacker.example/', []), PodNotAllowedError);
  });

  it('carries a 400 status', () => {
    assert.equal(new PodNotAllowedError().status, 400);
  });
});

describe('normalizePodUrl', () => {
  it('normalises http(s) URLs and rejects others', () => {
    assert.equal(normalizePodUrl('https://a.example/x'), 'https://a.example/x/');
    assert.equal(normalizePodUrl('javascript:alert(1)'), null);
    assert.equal(normalizePodUrl(42), null);
  });
});
