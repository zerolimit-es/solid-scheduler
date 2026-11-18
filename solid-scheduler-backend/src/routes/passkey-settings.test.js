import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-passkey-settings-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DB_ENCRYPTION_KEY;

const { passkeySiteFor, cleanDeviceName, MAX_DEVICE_NAME } = await import('./passkey.js');

describe('passkeySiteFor', () => {
  it("uses the frontend's hostname", () => {
    assert.equal(passkeySiteFor('https://scheduler.example.com', 'https://scheduler.example.com'), 'scheduler.example.com');
    assert.equal(passkeySiteFor('https://example.com', 'https://api.example.com'), 'example.com');
    assert.equal(passkeySiteFor('http://localhost:3000', 'http://localhost:3001'), 'localhost');
  });

  it('keeps the earlier value where passkeys could have been registered with it', () => {
    // Earlier versions dropped "app." from the backend's hostname
    assert.equal(passkeySiteFor('https://app.example.com', 'https://app.example.com'), 'example.com');
  });
});

describe('cleanDeviceName', () => {
  const clean = (deviceName) => {
    const req = { body: { body: {}, deviceName } };
    cleanDeviceName(req, {}, () => {});
    return req.body.deviceName;
  };

  it('keeps an ordinary name', () => {
    assert.equal(clean('Work laptop'), 'Work laptop');
  });

  it('caps the length and removes control characters', () => {
    assert.equal(clean('x'.repeat(500)).length, MAX_DEVICE_NAME);
    assert.equal(clean('Phone\r\nInjected: yes'), 'Phone  Injected: yes');
  });

  it('drops a name that is empty or not text, so the default is used', () => {
    assert.equal(clean('   '), undefined);
    assert.equal(clean({ toString: 'x' }), undefined);
  });
});
