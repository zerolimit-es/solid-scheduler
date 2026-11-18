import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-email-verify-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DB_ENCRYPTION_KEY;

let v;
before(async () => { v = await import('./email-verification-db.js'); });
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('confirmation emails per account', () => {
  it('sends at most one a minute, whatever the address', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T10:00:00Z') });
    assert.ok(v.startVerification('acct-a', 'one@example.com'));
    assert.equal(v.startVerification('acct-a', 'two@example.com'), null, 'another address straight away');
    assert.equal(v.startVerification('acct-a', 'one@example.com'), null, 'the same address straight away');
    assert.ok(v.startVerification('acct-b', 'three@example.com'), 'other accounts are not affected');
    t.mock.timers.tick(v.RESEND_AFTER_MS);
    assert.ok(v.startVerification('acct-a', 'two@example.com'), 'a minute later');
  });

  it('sends at most five a day', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-02-01T10:00:00Z') });
    for (let i = 0; i < v.MAX_SENDS_PER_DAY; i++) {
      assert.ok(v.startVerification('acct-c', `n${i}@example.com`), `send ${i + 1}`);
      t.mock.timers.tick(v.RESEND_AFTER_MS);
    }
    assert.equal(v.startVerification('acct-c', 'more@example.com'), null, 'the sixth that day');
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    assert.ok(v.startVerification('acct-c', 'more@example.com'), 'the next day');
  });

  it('confirms the address the latest link was sent to, once', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-03-01T10:00:00Z') });
    const { token } = v.startVerification('acct-d', 'Dee@Example.com');
    assert.equal(v.verificationStatus('acct-d', 'dee@example.com'), 'pending');
    assert.deepEqual(v.confirmVerification(token), { ok: true, email: 'dee@example.com' });
    assert.equal(v.verificationStatus('acct-d', 'dee@example.com'), 'verified');
    assert.equal(v.isConfirmedOrganizerEmail('DEE@example.com'), true);
    assert.deepEqual(v.confirmVerification(token), { ok: false, reason: 'unknown' });
  });

  it('refuses an expired link', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-04-01T10:00:00Z') });
    const { token } = v.startVerification('acct-e', 'e@example.com');
    t.mock.timers.tick(v.LINK_LIFETIME_MS + 1);
    assert.deepEqual(v.confirmVerification(token), { ok: false, reason: 'expired' });
    assert.equal(v.isConfirmedOrganizerEmail('e@example.com'), false);
  });
});
