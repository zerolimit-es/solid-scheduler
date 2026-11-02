/**
 * End to end through the real server: a signed-in session must reach routes
 * with a tenant. Before tenants were wired into server.js, every route keyed
 * on req.tenant failed for self-hosters (e.g. passkey registration answered
 * 400 "User not found").
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const SECRET = 'test-session-secret';
const COOKIE = 'solid-scheduler-session';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-e2e-'));
let child;
let baseUrl;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

/** A cookie-session cookie pair, signed the way keygrip does (HMAC-SHA1, base64url). */
function sessionCookie(session) {
  const value = Buffer.from(JSON.stringify(session)).toString('base64');
  const sig = crypto.createHmac('sha1', SECRET).update(`${COOKIE}=${value}`).digest('base64')
    .replace(/\/|\+|=/g, (c) => ({ '/': '_', '+': '-', '=': '' })[c]);
  return `${COOKIE}=${value}; ${COOKIE}.sig=${sig}`;
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(tmpDir, 'e2e.db'),
      SESSION_SECRET: SECRET, NODE_ENV: 'test', REDIS_URL: '', DB_ENCRYPTION_KEY: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  child?.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('server.js tenant wiring', () => {
  it('lets a signed-in user start passkey registration', async () => {
    const res = await fetch(`${baseUrl}/api/auth/passkey/register-options`, {
      headers: { Cookie: sessionCookie({ webId: 'https://frank.solidcommunity.net/profile/card#me' }) },
    });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.challenge);
  });

  it('still refuses anonymous requests', async () => {
    const res = await fetch(`${baseUrl}/api/auth/passkey/register-options`);
    assert.equal(res.status, 401);
  });
});
