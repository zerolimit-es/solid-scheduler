import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PasskeyChallenge from './PasskeyChallenge';
import { api } from '../../services/api';
import { startAuthentication } from '@simplewebauthn/browser';

vi.mock('../../services/api', () => ({ api: { passkey: { authOptions: vi.fn(), authVerify: vi.fn() } } }));
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn() }));

beforeEach(() => {
  api.passkey.authOptions.mockResolvedValue({ challenge: 'c' });
  api.passkey.authVerify.mockResolvedValue({ success: true, verified: true });
  startAuthentication.mockResolvedValue({ id: 'assertion' });
});

describe('PasskeyChallenge', () => {
  it('completes sign-in with a passkey', async () => {
    const onSuccess = vi.fn();
    render(<PasskeyChallenge onSuccess={onSuccess} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Verify with Passkey' }));
    expect(api.passkey.authVerify).toHaveBeenCalledWith({ id: 'assertion' });
    expect(onSuccess).toHaveBeenCalled();
  });

  it('explains a cancelled prompt and lets the person try again', async () => {
    startAuthentication.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    const onSuccess = vi.fn();
    render(<PasskeyChallenge onSuccess={onSuccess} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Verify with Passkey' }));
    expect(await screen.findByText(/cancelled or timed out/)).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Verify with Passkey' })).toBeEnabled();
  });

  it('says the request timed out when the server takes over 10 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Like apiFetch: the abort surfaces as a plain error, not an AbortError
    api.passkey.authOptions.mockImplementation(({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('This operation was aborted')));
    }));
    render(<PasskeyChallenge onSuccess={vi.fn()} />);
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByRole('button', { name: 'Verify with Passkey' }));
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(await screen.findByText('Request timed out — please try again.')).toBeInTheDocument();
  });
});
