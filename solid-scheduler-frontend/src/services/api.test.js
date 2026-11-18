import { describe, it, expect, vi, beforeEach } from 'vitest';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

// api.js keeps the CSRF token in module state: load a fresh copy per test
let apiFetch;
beforeEach(async () => {
  vi.resetModules();
  ({ apiFetch } = await import('./api'));
});

describe('apiFetch', () => {
  it('sends a CSRF token with a change, fetching it first', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ csrfToken: 'tok-1' }))
      .mockResolvedValueOnce(json({ success: true }));
    vi.stubGlobal('fetch', fetch);

    await apiFetch('/api/availability', { method: 'PUT', body: '{}' });
    expect(fetch.mock.calls[0][0]).toBe('/api/csrf-token');
    expect(fetch.mock.calls[1][1].headers['X-CSRF-Token']).toBe('tok-1');
  });

  it('sends no token on a read or to a public endpoint', async () => {
    const fetch = vi.fn().mockImplementation(async () => json({ ok: true }));
    vi.stubGlobal('fetch', fetch);

    await apiFetch('/api/availability');
    await apiFetch('/api/public/uma/book', { method: 'POST', body: '{}' });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) expect(init.headers['X-CSRF-Token']).toBeUndefined();
  });

  it('gets a new token and retries once when the token was refused', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ csrfToken: 'stale' }))
      .mockResolvedValueOnce(json({ message: 'CSRF token missing or invalid' }, 403))
      .mockResolvedValueOnce(json({ csrfToken: 'fresh' }))
      .mockResolvedValueOnce(json({ success: true }));
    vi.stubGlobal('fetch', fetch);

    expect(await apiFetch('/api/bookings', { method: 'POST', body: '{}' })).toEqual({ success: true });
    expect(fetch.mock.calls[3][1].headers['X-CSRF-Token']).toBe('fresh');
  });

  it("doesn't retry a refusal that isn't about the token", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ csrfToken: 'tok' }))
      .mockResolvedValueOnce(json({ error: 'passkey_reauth_required', message: 'Confirm with one of your passkeys first.' }, 403));
    vi.stubGlobal('fetch', fetch);

    await expect(apiFetch('/api/auth/passkey/x', { method: 'DELETE' }))
      .rejects.toMatchObject({ status: 403, message: 'Confirm with one of your passkeys first.' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('says what is wrong with each field instead of "Validation failed"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      json({ error: 'Validation failed', fields: { organizerEmail: 'Invalid email address' } }, 400)));
    await expect(apiFetch('/api/availability')).rejects.toThrow('Invalid email address');
  });

  it('reports a network failure as an error with status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiFetch('/api/availability')).rejects.toMatchObject({ status: 0 });
  });
});
