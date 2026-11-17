/**
 * Tests for src/middleware/rateLimit.js
 *
 * Tests the rate limiter configuration and behaviour by mounting
 * on a lightweight Express app. No external test dependencies.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { bookingLimiter, publicReadLimiter } from '../middleware/rateLimit.js';

// ── Helper: spin up a disposable Express server ──────────────────────────────

function createTestApp() {
  const app = express();
  app.use(express.json());

  // Booking endpoint with rate limiter
  app.post('/api/public/:slug/book', bookingLimiter, (req, res) => {
    res.json({ ok: true });
  });

  // Read endpoint with rate limiter
  app.get('/api/public/:slug', publicReadLimiter, (req, res) => {
    res.json({ ok: true });
  });

  return app;
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('bookingLimiter', () => {
  let server, base;

  before(async () => {
    const app = createTestApp();
    ({ server, base } = await listen(app));
  });

  after(() => server.close());

  it('allows requests under the limit', async () => {
    const res = await fetch(`${base}/api/public/test-slug/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });
    assert.equal(res.status, 200);
  });

  it('returns RateLimit-* headers', async () => {
    const res = await fetch(`${base}/api/public/test-slug/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });
    // express-rate-limit v7+ uses standard headers
    const limit = res.headers.get('ratelimit-limit');
    const remaining = res.headers.get('ratelimit-remaining');
    assert.ok(limit, 'should have RateLimit-Limit header');
    assert.ok(remaining !== null, 'should have RateLimit-Remaining header');
    assert.equal(Number(limit), 10, 'limit should be 10');
  });

  it('returns 429 after exceeding limit', async () => {
    // Burn through remaining requests (we used 2 above, limit is 10)
    for (let i = 0; i < 9; i++) {
      await fetch(`${base}/api/public/test-slug/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true }),
      });
    }

    // This should be over the limit
    const res = await fetch(`${base}/api/public/test-slug/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    });
    assert.equal(res.status, 429, 'should return 429 Too Many Requests');

    const body = await res.json();
    assert.ok(body.error, 'should have error message');
    assert.ok(body.error.includes('Too many'), 'error should mention too many attempts');
  });
});

describe('publicReadLimiter', () => {
  let server, base;

  before(async () => {
    const app = createTestApp();
    ({ server, base } = await listen(app));
  });

  after(() => server.close());

  it('allows requests under the limit', async () => {
    const res = await fetch(`${base}/api/public/test-slug`);
    assert.equal(res.status, 200);
  });

  it('has a limit of 30', async () => {
    const res = await fetch(`${base}/api/public/test-slug`);
    const limit = res.headers.get('ratelimit-limit');
    assert.equal(Number(limit), 30, 'read limit should be 30');
  });
});
