/**
 * Which screen the app shows: signed out, mid passkey check, signed in, a
 * public booking page (known or not) and a confirmation link. Sign-in is
 * stubbed; everything else goes through the real API layer to a fake server.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import useAuth from './hooks/useAuth';

vi.mock('./hooks/useAuth', () => ({ default: vi.fn() }));

const WEEK = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
  .map((d, i) => [d, { enabled: i < 5, start: '09:00', end: '17:00' }]));

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeServer(url) {
  const { pathname } = new URL(url, 'http://localhost');
  const routes = {
    '/api/csrf-token': { csrfToken: 't' },
    '/api/availability': { configured: true, emailVerification: 'verified',
      availability: { timezone: 'Europe/Paris', eventDuration: 30, bookingSlug: 'uma', organizerName: 'Uma', organizerEmail: 'uma@example.org', ...WEEK } },
    '/api/bookings/stats': { thisWeek: 0, thisMonth: 0, upcoming: 0 },
    '/api/bookings/upcoming': { bookings: [] },
    '/api/calendar/events': { timezone: 'Europe/Paris', from: '2030-09-16', to: '2030-12-15', events: [] },
    '/api/calendar/feed-token': { feedPath: '/cal/token.ics' },
    '/api/auth/passkey/list': { passkeys: [] },
    '/api/public/uma': { profile: { name: 'Uma Organizer' } },
    '/api/public/uma/availability': { timezone: 'Europe/Paris', eventDuration: 30, ...WEEK },
    '/api/public/uma/slots': { slots: [] },
  };
  if (pathname in routes) return json(routes[pathname]);
  if (pathname.startsWith('/api/public/')) return json({ error: 'Booking page not found' }, 404);
  return json({});
}

function signedIn(overrides = {}) {
  useAuth.mockReturnValue({
    user: { webId: 'https://uma.solidcommunity.net/profile/card#me', pods: [] },
    authLoading: false, loggingOut: false, mfaPending: false, handleMfaSuccess: vi.fn(),
    providers: [{ name: 'Inrupt PodSpaces', url: 'https://login.inrupt.com' }],
    selectedProvider: 'https://login.inrupt.com', setSelectedProvider: vi.fn(),
    handleLogin: vi.fn(), logout: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}
const signedOut = () => signedIn({ user: null });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url) => fakeServer(url)));
  window.history.replaceState(null, '', '/');
});

describe('App', () => {
  it('asks a signed-out visitor to sign in, showing why the last sign-in failed', () => {
    signedOut();
    window.history.replaceState(null, '', '/?login=failed&message=Provider%20refused');
    render(<App />);
    expect(screen.getByRole('button', { name: 'Login with Solid' })).toBeInTheDocument();
    expect(screen.getByText('Provider refused')).toBeInTheDocument();
  });

  it('asks for the passkey when sign-in needs one', () => {
    signedIn({ mfaPending: true });
    render(<App />);
    expect(screen.getByRole('button', { name: 'Verify with Passkey' })).toBeInTheDocument();
  });

  it("shows the organizer's dashboard, and the booking view from the navigation", async () => {
    signedIn();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Booking Page Settings' })).toBeInTheDocument();
    expect(await screen.findByText(`${window.location.origin}/book/uma`)).toBeInTheDocument();
    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Book' })[0]);
    expect(await screen.findByRole('heading', { name: 'Book a Meeting' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/booking');
  });

  it('shows a public booking page without signing in', async () => {
    signedOut();
    window.history.replaceState(null, '', '/book/uma');
    render(<App />);
    expect(await screen.findByText('Uma Organizer')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Book a Meeting' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Login with Solid' })).not.toBeInTheDocument();
  });

  it('says so when a booking link belongs to no one', async () => {
    signedOut();
    window.history.replaceState(null, '', '/book/nobody');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Booking page not found' })).toBeInTheDocument();
  });

  it('opens the email confirmation page from its link, signed in or not', () => {
    signedOut();
    window.history.replaceState(null, '', `/?confirmEmail=${'a'.repeat(64)}`);
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Confirm your email' })).toBeInTheDocument();
  });
});
