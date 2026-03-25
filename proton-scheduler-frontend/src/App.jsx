import React, { useState, useEffect } from 'react';

// Services & Hooks
import { useTheme } from './services/useTheme';
import { api, getDefaultAvailability } from './services/api';
import useAuth from './hooks/useAuth';
import useBookings from './hooks/useBookings';
import { extractDisplayName } from './utils/webid';

// Core components (always needed)
import Header from './components/layout/Header';
import LoginScreen from './components/layout/LoginScreen';
import DashboardView from './components/dashboard/DashboardView';
import BookingView from './components/booking/BookingView';
import BookingForm from './components/booking/BookingForm';
import ConfirmationView from './components/booking/ConfirmationView';
import { LoaderIcon, AlertIcon, LogOutIcon } from './components/common/Icons';
import { Moon, Sun, Monitor } from 'lucide-react';
import PasskeyChallenge from './components/common/PasskeyChallenge';

// No lazy-loaded components in open-source edition

export default function ProtonScheduler() {
  // ── Public booking page detection ──────────────────────────────────────
  const [publicSlug] = useState(() => {
    const match = window.location.pathname.match(/^\/book\/([^\/]+)/);
    return match ? match[1] : null;
  });

  // ── Capture login error from OIDC redirect before useAuth cleans it up ──
  const [loginError, setLoginError] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('login');
    if (status === 'error') return params.get('message') || 'Login failed. Please try again.';
    if (status === 'failed') return params.get('message') || 'Authentication failed — the identity provider did not complete login.';
    return null;
  });
  const [publicProfile, setPublicProfile] = useState(null);

  // ── Auth ───────────────────────────────────────────────────────────────
  const {
    user, setUser, authLoading, loggingOut,
    mfaPending, handleMfaSuccess,
    providers, selectedProvider, setSelectedProvider,
    handleLogin, logout,
  } = useAuth();

  // ── Theme & View ───────────────────────────────────────────────────────
  const { theme, setTheme } = useTheme();
  const [view, setView] = useState(() => {
    const seg = window.location.pathname.split('/')[1];
    const valid = ['dashboard', 'booking', 'support'];
    return valid.includes(seg) ? seg : 'dashboard';
  });
  const [error, setError] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // ── URL ↔ view sync ──────────────────────────────────────────────────
  useEffect(() => {
    if (publicSlug) return;
    const path = view === 'dashboard' ? '/' : `/${view}`;
    if (window.location.pathname !== path) {
      window.history.replaceState(null, '', path);
    }
  }, [view, publicSlug]);

  // ── Availability ───────────────────────────────────────────────────────
  const [availability, setAvailability] = useState(null);

  // ── Dashboard data ─────────────────────────────────────────────────────
  const [bookings, setBookings] = useState([]);
  const [stats, setStats] = useState({ thisWeek: 0, thisMonth: 0, upcoming: 0 });
  const [dataLoading, setDataLoading] = useState(false);
  const [podStatus, setPodStatus] = useState({ connected: false, lastSync: null, synced: 0, failed: 0, source: null });

  // ── Availability save ──────────────────────────────────────────────────
  const [availSaving, setAvailSaving] = useState(false);
  const [availSaved, setAvailSaved] = useState(false);

  // ── Booking flow (hook) ────────────────────────────────────────────────
  const booking = useBookings({
    user, publicSlug, availability, setView, setError,
    onBookingCreated: () => {
      if (user) api.bookings.getStats(user.pods[0]).then(setStats).catch(() => {});
    },
  });

  // ── Public page bootstrap ──────────────────────────────────────────────
  useEffect(() => {
    if (!publicSlug) return;
    fetch(`/api/public/${publicSlug}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setPublicProfile(data);
          fetch(`/api/public/${publicSlug}/availability`)
            .then(r => r.ok ? r.json() : null)
            .then(avail => {
              if (avail) {
                setAvailability(avail);
              } else {
                setAvailability({
                  ...data.profile,
                  monday:    { enabled: true,  start: '09:00', end: '17:00' },
                  tuesday:   { enabled: true,  start: '09:00', end: '17:00' },
                  wednesday: { enabled: true,  start: '09:00', end: '17:00' },
                  thursday:  { enabled: true,  start: '09:00', end: '17:00' },
                  friday:    { enabled: true,  start: '09:00', end: '17:00' },
                  saturday:  { enabled: false, start: '09:00', end: '17:00' },
                  sunday:    { enabled: false, start: '09:00', end: '17:00' },
                });
              }
            });
          setView('booking');
        }
      })
      .catch(() => {});
  }, [publicSlug]);

  // ── Fetch dashboard data when authenticated ────────────────────────────
  useEffect(() => {
    if (!user) return;

    const fetchData = async () => {
      setDataLoading(true);
      try {
        // Pod is connected if user has pods
        if (user.pods?.length > 0) {
          setPodStatus(prev => ({ ...prev, connected: true }));
        }

        const [availRes, statsRes] = await Promise.all([
          api.availability.get(user.pods[0]).catch(() => null),
          api.bookings.getStats(user.pods[0]).catch(() => ({})),
        ]);

        if (availRes?.configured) {
          setAvailability(availRes.availability);
        } else {
          setAvailability(getDefaultAvailability());
        }

        setStats(statsRes);

        const bookingsRes = await api.bookings.list(user.pods[0]).catch(() => ({ bookings: [] }));
        setBookings(bookingsRes.bookings || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setDataLoading(false);
      }
    };

    fetchData();
  }, [user]);

  // ── Handlers ───────────────────────────────────────────────────────────

  const handleLogout = async () => {
    await logout();
    setAvailability(null);
    setBookings([]);
  };

  const handleSaveAvailability = async () => {
    if (!user || !availability) return;
    setAvailSaving(true);
    setError(null);
    try {
      await api.availability.update(availability, user.pods[0]);
      setAvailSaved(true);
      setTimeout(() => setAvailSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setAvailSaving(false);
    }
  };

  const toggleDay = (day) => {
    setAvailability(prev => ({
      ...prev,
      days: {
        ...prev.days,
        [day]: { ...prev.days[day], enabled: !prev.days[day].enabled },
      },
    }));
  };

  const copyBookingLink = () => {
    const slug = user?.bookingSlug || availability?.bookingSlug || 'my-booking';
    navigator.clipboard.writeText(`${window.location.origin}/book/${slug}`);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const isDateAvailable = (date) => {
    if (date < new Date().setHours(0, 0, 0, 0)) return false;
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return availability?.days?.[dayNames[date.getDay()]]?.enabled ?? false;
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  Render
  // ═══════════════════════════════════════════════════════════════════════

  // Loading screen
  if (authLoading && !publicSlug) {
    return (
      <div className="proton-scheduler">
        <div className="grain-overlay" />
        <div className="flex flex-col items-center justify-center min-h-screen gap-4">
          <LoaderIcon className="w-12 h-12 text-[var(--color-info)]" />
          <p>Connecting to Solid...</p>
        </div>
      </div>
    );
  }

  // Logging out screen
  if (loggingOut && !publicSlug) {
    return (
      <div className="proton-scheduler">
        <div className="grain-overlay" />
        <div className="flex flex-col items-center justify-center min-h-screen gap-4">
          <LoaderIcon className="w-12 h-12 text-[var(--color-info)]" />
          <p>Logging out...</p>
        </div>
      </div>
    );
  }

  // MFA passkey challenge
  if (user && mfaPending && !publicSlug) {
    return (
      <div className="proton-scheduler">
        <div className="grain-overlay" />
        <PasskeyChallenge onSuccess={handleMfaSuccess} />
      </div>
    );
  }

  // Login screen
  if (!user && !publicSlug) {
    return (
      <div className="proton-scheduler">
        <div className="grain-overlay" />
        <div className="max-w-[1200px] mx-auto p-8 relative z-[1]">
          <LoginScreen
            providers={providers}
            selectedProvider={selectedProvider}
            setSelectedProvider={setSelectedProvider}
            handleLogin={handleLogin}
          />
          {loginError && (
            <div className="max-w-[420px] mx-auto mt-4">
              <div className="flex items-center gap-3 py-3.5 px-4 bg-red-500/10 border border-red-500/30 rounded-lg text-[var(--color-error)]">
                <AlertIcon style={{ width: 18, height: 18 }} />
                <span>{loginError}</span>
                <button className="ml-auto bg-none border-none text-[var(--color-error)] cursor-pointer text-xl leading-none" onClick={() => setLoginError(null)}>×</button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Public booking page (no login required) ────────────────────────────
  if (publicSlug) {
    return (
      <div className="proton-scheduler">
        <div className="grain-overlay" />
        <div className="max-w-[1200px] mx-auto p-8 relative z-[1]">
          <header className="flex justify-between items-center mb-8 pb-6 border-b border-[var(--theme-header-border)] flex-wrap gap-4">
            <div className="flex-1" />
            <div className="flex items-center gap-3">
              <span className="font-display text-lg font-bold bg-gradient-to-br from-user-primary to-user-light bg-clip-text text-transparent">
                {publicProfile?.profile?.name || 'ProtonScheduler'}
              </span>
            </div>
            <div className="flex-1 flex justify-end">
              <button
                onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
                className="w-9 h-9 rounded-lg flex items-center justify-center border-2 border-user-primary/40 bg-user-primary/10 text-user-primary cursor-pointer transition-all duration-200 hover:bg-user-primary/20 hover:border-user-primary/60"
                title={`Theme: ${theme}`}
              >
                {theme === 'dark' ? <Moon size={16} strokeWidth={1.8} /> : theme === 'light' ? <Sun size={16} strokeWidth={1.8} /> : <Monitor size={16} strokeWidth={1.8} />}
              </button>
            </div>
          </header>

          {error && (
            <div className="flex items-center gap-3 py-3.5 px-4 bg-red-500/10 border border-red-500/30 rounded-lg mb-6 text-[var(--color-error)]">
              <AlertIcon style={{ width: 18, height: 18 }} />
              <span>{error}</span>
              <button className="ml-auto bg-none border-none text-[var(--color-error)] cursor-pointer text-xl leading-none" onClick={() => setError(null)}>×</button>
            </div>
          )}

          {view === 'booking' && (
            <BookingView
              availability={availability}
              currentMonth={booking.currentMonth}
              setCurrentMonth={booking.setCurrentMonth}
              selectedDate={booking.selectedDate}
              setSelectedDate={booking.setSelectedDate}
              selectedSlot={booking.selectedSlot}
              setSelectedSlot={booking.setSelectedSlot}
              slots={booking.slots}
              slotsLoading={booking.slotsLoading}
              setView={setView}
            />
          )}
          {view === 'form' && (
            <BookingForm
              selectedDate={booking.selectedDate}
              selectedSlot={booking.selectedSlot}
              availability={availability}
              bookingForm={booking.bookingForm}
              setBookingForm={booking.setBookingForm}
              handleBooking={booking.handleBooking}
              saving={booking.saving}
              setView={setView}
            />
          )}
          {view === 'confirmation' && booking.bookedEvent && (
            <ConfirmationView
              bookedEvent={booking.bookedEvent}
              setView={setView}
              setBookedEvent={booking.setBookedEvent}
              setSelectedDate={booking.setSelectedDate}
              setSelectedSlot={booking.setSelectedSlot}
              setBookingForm={booking.setBookingForm}
              isPublic
            />
          )}
          {!availability && (
            <div className="flex flex-col items-center justify-center min-h-screen gap-4">
              <LoaderIcon className="w-12 h-12 text-[var(--color-info)]" />
              <p>Loading availability...</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Authenticated app ──────────────────────────────────────────────────
  return (
    <div className="proton-scheduler">
      <div className="grain-overlay" />
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:px-4 focus:py-2 focus:bg-[var(--brand-primary)] focus:text-white focus:rounded-lg">
        Skip to main content
      </a>

      <div className="max-w-[1200px] mx-auto p-8 relative z-[1]">

        <Header
          user={user}
          view={view}
          setView={setView}
          handleLogout={handleLogout}
          theme={theme}
          setTheme={setTheme}
        />

        {/* Error Banner */}
        <div role="alert" aria-live="assertive">
          {error && (
            <div className="flex items-center gap-3 py-3.5 px-4 bg-red-500/10 border border-red-500/30 rounded-lg mb-6 text-[var(--color-error)]">
              <AlertIcon style={{ width: 18, height: 18 }} />
              <span>{error}</span>
              <button className="ml-auto bg-none border-none text-[var(--color-error)] cursor-pointer text-xl leading-none" onClick={() => setError(null)} aria-label="Dismiss error">×</button>
            </div>
          )}
        </div>

        <main id="main-content">
        {view === 'dashboard' && (
          <DashboardView
            user={user}
            availability={availability}
            bookings={bookings}
            setBookings={setBookings}
            stats={stats}
            podStatus={podStatus}
            setPodStatus={setPodStatus}
            linkCopied={linkCopied}
            setLinkCopied={setLinkCopied}
            saving={availSaving}
            setSaving={setAvailSaving}
            saved={availSaved}
            setSaved={setAvailSaved}
            handleSaveAvailability={handleSaveAvailability}
            setAvailability={setAvailability}
            setError={setError}
          />
        )}

        {view === 'booking' && (
          <BookingView
            availability={availability}
            currentMonth={booking.currentMonth}
            setCurrentMonth={booking.setCurrentMonth}
            selectedDate={booking.selectedDate}
            setSelectedDate={booking.setSelectedDate}
            selectedSlot={booking.selectedSlot}
            setSelectedSlot={booking.setSelectedSlot}
            slots={booking.slots}
            slotsLoading={booking.slotsLoading}
            setView={setView}
          />
        )}

        {view === 'form' && (
          <BookingForm
            selectedDate={booking.selectedDate}
            selectedSlot={booking.selectedSlot}
            availability={availability}
            bookingForm={booking.bookingForm}
            setBookingForm={booking.setBookingForm}
            handleBooking={booking.handleBooking}
            saving={booking.saving}
            setView={setView}
          />
        )}

        {view === 'confirmation' && booking.bookedEvent && (
          <ConfirmationView
            bookedEvent={booking.bookedEvent}
            setView={setView}
            setBookedEvent={booking.setBookedEvent}
            setSelectedDate={booking.setSelectedDate}
            setSelectedSlot={booking.setSelectedSlot}
            setBookingForm={booking.setBookingForm}
          />
        )}

        {view === 'support' && (
          <div className="text-center py-20">
            <h2 className="font-serif text-xl font-semibold mb-4" style={{ color: 'var(--color-text-primary)' }}>Support</h2>
            <p className="text-sm mb-4" style={{ color: 'var(--theme-text-muted)' }}>
              ProtonScheduler is open-source software.
            </p>
            <a href="https://github.com/zerolimit-es/proton-scheduler/issues" target="_blank" rel="noopener noreferrer" className="text-[var(--color-primary-light)] no-underline text-sm">
              Report an issue on GitHub →
            </a>
          </div>
        )}
        </main>

      </div>
    </div>
  );
}
