/**
 * Tests for src/middleware/validate.js
 *
 * Uses Node built-in test runner (node --test).
 * No external test dependencies required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validate, publicBookingSchema, createBookingSchema, updateAvailabilitySchema } from '../middleware/validate.js';

// ── Helper: fake Express req/res/next ────────────────────────────────────────

function mockReq(body) {
  return { body };
}

function mockRes() {
  const res = {
    _status: null,
    _json: null,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
  };
  return res;
}

function mockNext() {
  let called = false;
  const fn = () => { called = true; };
  fn.wasCalled = () => called;
  return fn;
}

// ── validate() middleware factory ─────────────────────────────────────────────

describe('validate() middleware', () => {
  it('calls next() on valid input', () => {
    const req = mockReq({ date: '2026-03-01', time: '10:00', name: 'Alice', email: 'alice@test.com' });
    const res = mockRes();
    const next = mockNext();

    validate(publicBookingSchema)(req, res, next);

    assert.ok(next.wasCalled(), 'next() should be called');
    assert.equal(res._status, null, 'should not set status');
  });

  it('replaces req.body with parsed data (strips unknown fields)', () => {
    const req = mockReq({
      date: '2026-03-01', time: '10:00', name: 'Alice', email: 'alice@test.com',
      malicious: '<script>alert(1)</script>',
    });
    const res = mockRes();
    const next = mockNext();

    validate(publicBookingSchema)(req, res, next);

    assert.ok(next.wasCalled());
    assert.equal(req.body.malicious, undefined, 'unknown fields should be stripped');
    assert.equal(req.body.date, '2026-03-01');
  });

  it('returns 400 with field errors on invalid input', () => {
    const req = mockReq({ date: 'bad', time: 'bad', name: '', email: 'notanemail' });
    const res = mockRes();
    const next = mockNext();

    validate(publicBookingSchema)(req, res, next);

    assert.ok(!next.wasCalled(), 'next() should NOT be called');
    assert.equal(res._status, 400);
    assert.equal(res._json.error, 'Validation failed');
    assert.ok(res._json.fields.date, 'should have date error');
    assert.ok(res._json.fields.time, 'should have time error');
    assert.ok(res._json.fields.name, 'should have name error');
    assert.ok(res._json.fields.email, 'should have email error');
  });

  it('returns 400 on completely empty body', () => {
    const req = mockReq({});
    const res = mockRes();
    const next = mockNext();

    validate(publicBookingSchema)(req, res, next);

    assert.ok(!next.wasCalled());
    assert.equal(res._status, 400);
  });
});

// ── publicBookingSchema ──────────────────────────────────────────────────────

describe('publicBookingSchema', () => {
  const valid = { date: '2026-03-15', time: '14:30', name: 'Bob', email: 'bob@example.com' };

  it('accepts minimal valid booking', () => {
    const result = publicBookingSchema.safeParse(valid);
    assert.ok(result.success);
    assert.equal(result.data.notes, '');
    assert.equal(result.data.recurrence, null);
  });

  it('accepts full booking with recurrence', () => {
    const result = publicBookingSchema.safeParse({
      ...valid,
      notes: 'Please bring slides',
      recurrence: { frequency: 'WEEKLY', byDay: ['MO', 'WE', 'FR'] },
    });
    assert.ok(result.success);
    assert.equal(result.data.recurrence.frequency, 'WEEKLY');
    assert.deepEqual(result.data.recurrence.byDay, ['MO', 'WE', 'FR']);
  });

  it('rejects date without dashes', () => {
    const result = publicBookingSchema.safeParse({ ...valid, date: '20260315' });
    assert.ok(!result.success);
  });

  it('rejects date with slashes', () => {
    const result = publicBookingSchema.safeParse({ ...valid, date: '2026/03/15' });
    assert.ok(!result.success);
  });

  it('rejects path traversal in date', () => {
    const result = publicBookingSchema.safeParse({ ...valid, date: '../../etc/passwd' });
    assert.ok(!result.success);
  });

  it('rejects time without colon', () => {
    const result = publicBookingSchema.safeParse({ ...valid, time: '1430' });
    assert.ok(!result.success);
  });

  it('rejects empty name', () => {
    const result = publicBookingSchema.safeParse({ ...valid, name: '' });
    assert.ok(!result.success);
  });

  it('rejects name over 100 chars', () => {
    const result = publicBookingSchema.safeParse({ ...valid, name: 'A'.repeat(101) });
    assert.ok(!result.success);
  });

  it('rejects invalid email', () => {
    const result = publicBookingSchema.safeParse({ ...valid, email: 'not-an-email' });
    assert.ok(!result.success);
  });

  it('rejects notes over 1000 chars', () => {
    const result = publicBookingSchema.safeParse({ ...valid, notes: 'X'.repeat(1001) });
    assert.ok(!result.success);
  });

  it('rejects invalid recurrence frequency', () => {
    const result = publicBookingSchema.safeParse({ ...valid, recurrence: { frequency: 'HOURLY' } });
    assert.ok(!result.success);
  });

  it('rejects invalid byDay values', () => {
    const result = publicBookingSchema.safeParse({
      ...valid,
      recurrence: { frequency: 'WEEKLY', byDay: ['MONDAY'] },
    });
    assert.ok(!result.success);
  });
});

// ── createBookingSchema ──────────────────────────────────────────────────────

describe('createBookingSchema', () => {
  it('accepts valid authenticated booking', () => {
    const result = createBookingSchema.safeParse({
      date: '2026-04-01', time: '09:00', name: 'Carol', email: 'carol@corp.com',
      notes: 'Quarterly review',
    });
    assert.ok(result.success);
  });

  it('applies same date/time format rules as public schema', () => {
    const result = createBookingSchema.safeParse({
      date: 'March 1', time: '9am', name: 'Carol', email: 'carol@corp.com',
    });
    assert.ok(!result.success);
    assert.ok(result.error.issues.some(i => i.path.includes('date')));
    assert.ok(result.error.issues.some(i => i.path.includes('time')));
  });
});

// ── updateAvailabilitySchema ─────────────────────────────────────────────────

describe('updateAvailabilitySchema', () => {
  it('accepts valid availability update', () => {
    const result = updateAvailabilitySchema.safeParse({
      eventDuration: 45,
      timezone: 'America/New_York',
      monday: { enabled: true, start: '08:00', end: '16:00' },
      saturday: { enabled: false, start: '09:00', end: '17:00' },
    });
    assert.ok(result.success);
  });

  it('accepts empty object (partial update)', () => {
    const result = updateAvailabilitySchema.safeParse({});
    assert.ok(result.success);
  });

  it('rejects eventDuration under 5', () => {
    const result = updateAvailabilitySchema.safeParse({ eventDuration: 2 });
    assert.ok(!result.success);
  });

  it('rejects eventDuration over 480', () => {
    const result = updateAvailabilitySchema.safeParse({ eventDuration: 600 });
    assert.ok(!result.success);
  });

  it('rejects invalid email format', () => {
    const result = updateAvailabilitySchema.safeParse({ email: 'not-valid' });
    assert.ok(!result.success);
  });

  it('allows empty string email (clearing the field)', () => {
    const result = updateAvailabilitySchema.safeParse({ email: '' });
    assert.ok(result.success);
  });

  it('passes through unknown fields (passthrough mode)', () => {
    const result = updateAvailabilitySchema.safeParse({ customField: 'hello' });
    assert.ok(result.success);
    assert.equal(result.data.customField, 'hello');
  });
});
