import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import LoginScreen from './LoginScreen';

const PROVIDERS = [
  { name: 'Inrupt PodSpaces', url: 'https://login.inrupt.com' },
  { name: 'solidcommunity.net', url: 'https://solidcommunity.net' },
  { name: 'Self-hosted' }, // no address: covered by "Other provider…"
];

function Harness({ initial = 'https://login.inrupt.com', handleLogin = vi.fn() }) {
  const [selected, setSelected] = React.useState(initial);
  return (
    <>
      <LoginScreen providers={PROVIDERS} selectedProvider={selected} setSelectedProvider={setSelected} handleLogin={handleLogin} />
      <output data-testid="selected">{selected}</output>
    </>
  );
}

describe('LoginScreen', () => {
  it('lists the providers that have an address, plus "Other provider…"', () => {
    render(<Harness />);
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Inrupt PodSpaces', 'solidcommunity.net', 'Other provider…']);
  });

  it('signs in with the chosen provider', async () => {
    const user = userEvent.setup();
    const handleLogin = vi.fn();
    render(<Harness handleLogin={handleLogin} />);
    await user.selectOptions(screen.getByLabelText('Solid Identity Provider'), 'solidcommunity.net');
    expect(screen.getByTestId('selected')).toHaveTextContent('https://solidcommunity.net');
    await user.click(screen.getByRole('button', { name: 'Login with Solid' }));
    expect(handleLogin).toHaveBeenCalled();
  });

  it('takes a typed provider address, and only a valid http(s) one', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText('Solid Identity Provider'), 'Other provider…');
    const address = screen.getByLabelText('Provider address');
    const login = screen.getByRole('button', { name: 'Login with Solid' });
    expect(login).toBeDisabled();

    await user.type(address, 'ftp://id.example.org');
    expect(address).toHaveAttribute('aria-invalid', 'true');
    expect(login).toBeDisabled();

    await user.clear(address);
    await user.type(address, 'https://id.example.org');
    expect(address).toHaveAttribute('aria-invalid', 'false');
    expect(login).toBeEnabled();
  });

  it('shows the address field for a provider that is not on the list', () => {
    render(<Harness initial="https://my-own-idp.example" />);
    expect(screen.getByLabelText('Provider address')).toHaveValue('https://my-own-idp.example');
  });
});
