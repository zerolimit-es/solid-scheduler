import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmEmailView from './ConfirmEmailView';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const TOKEN = 'a'.repeat(64);

describe('ConfirmEmailView', () => {
  it('confirms nothing until the button is pressed', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<ConfirmEmailView token={TOKEN} />);
    expect(screen.getByRole('heading', { name: 'Confirm your email' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('confirms the address when asked', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ confirmed: true }));
    vi.stubGlobal('fetch', fetch);
    render(<ConfirmEmailView token={TOKEN} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm my email' }));
    expect(await screen.findByRole('heading', { name: 'Email confirmed' })).toBeInTheDocument();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/public/verify-email');
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
  });

  it('says when a link has expired or was already used', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(
      { confirmed: false, reason: 'expired', error: 'This link has expired. Send a new one from your booking page settings.' }, 400)));
    render(<ConfirmEmailView token={TOKEN} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm my email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has expired');
  });

  it('lets the person try again when the server is out of reach', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<ConfirmEmailView token={TOKEN} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm my email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the server");
    expect(screen.getByRole('button', { name: 'Confirm my email' })).toBeEnabled();
  });
});
