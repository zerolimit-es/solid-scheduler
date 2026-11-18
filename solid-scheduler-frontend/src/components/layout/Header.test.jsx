import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Header from './Header';

function setup(props = {}) {
  const handlers = { setView: vi.fn(), handleLogout: vi.fn(), setTheme: vi.fn() };
  render(<Header user={{ webId: 'https://uma.solidcommunity.net/profile/card#me' }} view="dashboard" theme="dark" {...handlers} {...props} />);
  return { user: userEvent.setup(), ...handlers };
}

describe('Header', () => {
  it("shows who is signed in and marks the current page", () => {
    setup({ view: 'form' });
    expect(screen.getByText('uma')).toBeInTheDocument();
    const [nav] = screen.getAllByRole('navigation', { name: 'Main navigation' });
    expect(nav.querySelector('[aria-current="page"]')).toHaveTextContent('Book');
  });

  it('navigates, signs out and switches theme', async () => {
    const { user, setView, handleLogout, setTheme } = setup();
    await user.click(screen.getAllByRole('button', { name: 'Support' })[0]);
    expect(setView).toHaveBeenCalledWith('support');
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    expect(handleLogout).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Current theme: dark/ }));
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('opens the mobile menu and closes it with Escape, returning focus to the button', async () => {
    const { user } = setup();
    const toggle = screen.getByRole('button', { name: 'Open menu' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('mobile-menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveFocus();
  });

  it('closes the mobile menu on a click outside it', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(document.body);
    expect(document.getElementById('mobile-menu')).not.toBeInTheDocument();
  });
});
