import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** Load the config afresh with the given environment. */
async function loadConfig(env) {
  const names = ['SMTP_PORT', 'SMTP_SECURE', 'SMTP_FROM', 'EMAIL_FROM', 'TRUST_PROXY'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, env);
  const warn = console.warn;
  console.warn = () => {};
  try {
    return (await import(`./index.js?case=${Math.random()}`)).default;
  } finally {
    console.warn = warn;
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n];
    }
  }
}

describe('email settings', () => {
  it('uses implicit TLS on port 465 when SMTP_SECURE=true', async () => {
    const { email } = await loadConfig({ SMTP_PORT: '465', SMTP_SECURE: 'true' });
    assert.deepEqual([email.secure, email.requireTLS], [true, false]);
  });

  it('uses STARTTLS on port 587, required when SMTP_SECURE=true', async () => {
    const strict = (await loadConfig({ SMTP_PORT: '587', SMTP_SECURE: 'true' })).email;
    assert.deepEqual([strict.secure, strict.requireTLS], [false, true]);
    const plain = (await loadConfig({ SMTP_PORT: '587', SMTP_SECURE: 'false' })).email;
    assert.deepEqual([plain.secure, plain.requireTLS], [false, false]);
  });

  it('reads the sender from SMTP_FROM, or EMAIL_FROM, its older name', async () => {
    assert.equal((await loadConfig({ SMTP_FROM: 'a@example.com', EMAIL_FROM: 'b@example.com' })).email.from, 'a@example.com');
    assert.equal((await loadConfig({ EMAIL_FROM: 'b@example.com' })).email.from, 'b@example.com');
  });
});

describe('TRUST_PROXY', () => {
  it('defaults to one proxy and accepts a hop count', async () => {
    assert.equal((await loadConfig({})).trustProxy, 1);
    assert.equal((await loadConfig({ TRUST_PROXY: '2' })).trustProxy, 2);
  });

  it('rejects anything that is not a hop count', async () => {
    await assert.rejects(loadConfig({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
  });
});
