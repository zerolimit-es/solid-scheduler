import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SecurityCard from './SecurityCard';
import { api } from '../../services/api';
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';

vi.mock('../../services/api', () => ({
  api: { passkey: {
    list: vi.fn(), registerOptions: vi.fn(), registerVerify: vi.fn(),
    authOptions: vi.fn(), authVerify: vi.fn(), remove: vi.fn(),
  } },
}));
vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(), startAuthentication: vi.fn(), browserSupportsWebAuthn: vi.fn(),
}));

const LAPTOP = { id: 'pk1', deviceName: 'Work laptop', createdAt: '2030-01-02 10:00:00', lastUsedAt: null };
const reauthNeeded = () => Object.assign(new Error('Confirm with one of your passkeys first.'), {
  status: 403, data: { error: 'passkey_reauth_required' },
});

beforeEach(() => {
  browserSupportsWebAuthn.mockReturnValue(true);
  api.passkey.list.mockResolvedValue({ passkeys: [] });
  api.passkey.registerOptions.mockResolvedValue({ challenge: 'reg' });
  api.passkey.registerVerify.mockResolvedValue({ success: true });
  api.passkey.authOptions.mockResolvedValue({ challenge: 'auth' });
  api.passkey.authVerify.mockResolvedValue({ success: true, verified: true });
  startRegistration.mockResolvedValue({ id: 'cred' });
  startAuthentication.mockResolvedValue({ id: 'assertion' });
});

describe('SecurityCard', () => {
  it('lists passkeys, and says the check is on', async () => {
    api.passkey.list.mockResolvedValue({ passkeys: [LAPTOP] });
    render(<SecurityCard />);
    const list = await screen.findByRole('list', { name: 'Your passkeys' });
    expect(within(list).getByText('Work laptop')).toBeInTheDocument();
    expect(within(list).getByText(/Not used yet/)).toBeInTheDocument();
    expect(screen.getByText(/Passkey check is on/)).toBeInTheDocument();
  });

  it('adds a first passkey with the name given', async () => {
    const user = userEvent.setup();
    render(<SecurityCard />);
    await user.type(await screen.findByLabelText('Passkey name'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Add a passkey' }));
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'reg' } });
    expect(api.passkey.registerVerify).toHaveBeenCalledWith({ id: 'cred' }, 'Phone');
    expect(await screen.findByRole('status')).toHaveTextContent(/asked for it each time you sign in/);
  });

  it('asks for an existing passkey first when the server requires it, then retries', async () => {
    const user = userEvent.setup();
    api.passkey.list.mockResolvedValue({ passkeys: [LAPTOP] });
    api.passkey.registerOptions.mockRejectedValueOnce(reauthNeeded()).mockResolvedValueOnce({ challenge: 'reg' });
    render(<SecurityCard />);
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'auth' } });
    expect(api.passkey.authVerify).toHaveBeenCalledWith({ id: 'assertion' });
    expect(api.passkey.registerOptions).toHaveBeenCalledTimes(2);
    expect(api.passkey.registerVerify).toHaveBeenCalled();
  });

  it('explains a cancelled passkey prompt', async () => {
    const user = userEvent.setup();
    startRegistration.mockRejectedValue(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
    render(<SecurityCard />);
    await user.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cancelled or timed out');
  });

  it('warns before removing the last passkey, and removes it when confirmed', async () => {
    const user = userEvent.setup();
    api.passkey.list.mockResolvedValueOnce({ passkeys: [LAPTOP] }).mockResolvedValueOnce({ passkeys: [] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SecurityCard />);
    await user.click(await screen.findByRole('button', { name: 'Remove passkey Work laptop' }));
    expect(confirm.mock.calls[0][0]).toMatch(/only passkey, so sign-in will no longer ask for one/);
    expect(api.passkey.remove).toHaveBeenCalledWith('pk1');
    expect(await screen.findByText(/Add a passkey to require a second step/)).toBeInTheDocument();
  });

  it("says when the browser can't use passkeys", async () => {
    browserSupportsWebAuthn.mockReturnValue(false);
    render(<SecurityCard />);
    expect(await screen.findByText("This browser doesn't support passkeys.")).toBeInTheDocument();
  });
});
