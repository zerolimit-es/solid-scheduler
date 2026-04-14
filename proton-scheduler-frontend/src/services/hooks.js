/**
 * Custom React Hooks for SolidScheduler
 * 
 * Provides hooks for:
 * - Authentication state management
 * - Availability data fetching
 * - Bookings management
 * - Loading and error states
 */

import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { authApi, availabilityApi, bookingsApi, checkAuth } from './api';

// =============================================================================
// Auth Context
// =============================================================================

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Check auth status on mount and after login redirect
  useEffect(() => {
    const checkAuthStatus = async () => {
      try {
        setLoading(true);
        const status = await authApi.getStatus();
        if (status.isLoggedIn) {
          setUser({
            webId: status.webId,
            sessionId: status.sessionId,
            pods: status.pods || [],
          });
        } else {
          setUser(null);
        }
        setError(null);
      } catch (err) {
        console.error('Auth check failed:', err);
        setError(err.message);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };

    checkAuthStatus();

    // Check for login callback
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('login')) {
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname);
      checkAuthStatus();
    }
  }, []);

  const login = useCallback((oidcIssuer) => {
    const returnTo = window.location.origin;
    window.location.href = authApi.getLoginUrl(oidcIssuer, returnTo);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
      setUser(null);
    } catch (err) {
      console.error('Logout failed:', err);
      // Still clear local state
      setUser(null);
    }
  }, []);

  const value = {
    user,
    loading,
    error,
    isAuthenticated: !!user,
    login,
    logout,
    podUrl: user?.pods?.[0] || null,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// =============================================================================
// Availability Hook
// =============================================================================

export function useAvailability() {
  const { isAuthenticated, podUrl } = useAuth();
  const [availability, setAvailability] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Fetch availability on mount
  const fetchAvailability = useCallback(async () => {
    if (!isAuthenticated) return;
    
    try {
      setLoading(true);
      setError(null);
      const result = await availabilityApi.get(podUrl);
      if (result.configured) {
        setAvailability(result.availability);
      } else {
        // Set default availability
        setAvailability(getDefaultAvailability());
      }
    } catch (err) {
      console.error('Failed to fetch availability:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, podUrl]);

  useEffect(() => {
    fetchAvailability();
  }, [fetchAvailability]);

  // Save availability
  const saveAvailability = useCallback(async (newAvailability) => {
    if (!isAuthenticated) return;
    
    try {
      setSaving(true);
      setError(null);
      await availabilityApi.update(newAvailability, podUrl);
      setAvailability(newAvailability);
      return true;
    } catch (err) {
      console.error('Failed to save availability:', err);
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [isAuthenticated, podUrl]);

  // Update local state
  const updateAvailability = useCallback((updates) => {
    setAvailability(prev => ({
      ...prev,
      ...updates,
    }));
  }, []);

  // Toggle day enabled
  const toggleDay = useCallback((day) => {
    setAvailability(prev => ({
      ...prev,
      days: {
        ...prev.days,
        [day]: {
          ...prev.days[day],
          enabled: !prev.days[day].enabled,
        },
      },
    }));
  }, []);

  return {
    availability,
    loading,
    error,
    saving,
    fetchAvailability,
    saveAvailability,
    updateAvailability,
    toggleDay,
  };
}

// =============================================================================
// Bookings Hook
// =============================================================================

export function useBookings() {
  const { isAuthenticated, podUrl } = useAuth();
  const [bookings, setBookings] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch bookings
  const fetchBookings = useCallback(async (options = {}) => {
    if (!isAuthenticated) return;
    
    try {
      setLoading(true);
      setError(null);
      const result = await bookingsApi.list({ ...options, pod: podUrl });
      setBookings(result.bookings || []);
    } catch (err) {
      console.error('Failed to fetch bookings:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, podUrl]);

  // Fetch upcoming bookings
  const fetchUpcoming = useCallback(async (limit = 10) => {
    if (!isAuthenticated) return;
    
    try {
      setLoading(true);
      const result = await bookingsApi.getUpcoming(limit, podUrl);
      setBookings(result.bookings || []);
    } catch (err) {
      console.error('Failed to fetch upcoming:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isAuthenticated, podUrl]);

  // Fetch stats
  const fetchStats = useCallback(async () => {
    if (!isAuthenticated) return;
    
    try {
      const result = await bookingsApi.getStats(podUrl);
      setStats(result);
    } catch (err) {
      console.error('Failed to fetch stats:', err);
    }
  }, [isAuthenticated, podUrl]);

  // Create booking
  const createBooking = useCallback(async (booking) => {
    if (!isAuthenticated) return null;
    
    try {
      setError(null);
      const result = await bookingsApi.create(booking, podUrl);
      // Refresh bookings
      fetchBookings();
      fetchStats();
      return result;
    } catch (err) {
      console.error('Failed to create booking:', err);
      setError(err.message);
      throw err;
    }
  }, [isAuthenticated, podUrl, fetchBookings, fetchStats]);

  // Cancel booking
  const cancelBooking = useCallback(async (id, options = {}) => {
    if (!isAuthenticated) return false;
    
    try {
      setError(null);
      await bookingsApi.cancel(id, options, podUrl);
      // Refresh bookings
      fetchBookings();
      fetchStats();
      return true;
    } catch (err) {
      console.error('Failed to cancel booking:', err);
      setError(err.message);
      return false;
    }
  }, [isAuthenticated, podUrl, fetchBookings, fetchStats]);

  // Initial fetch
  useEffect(() => {
    if (isAuthenticated) {
      fetchUpcoming();
      fetchStats();
    }
  }, [isAuthenticated, fetchUpcoming, fetchStats]);

  return {
    bookings,
    stats,
    loading,
    error,
    fetchBookings,
    fetchUpcoming,
    fetchStats,
    createBooking,
    cancelBooking,
  };
}

// =============================================================================
// Available Slots Hook
// =============================================================================

export function useAvailableSlots(selectedDate) {
  const { isAuthenticated, podUrl } = useAuth();
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!selectedDate || !isAuthenticated) {
      setSlots([]);
      return;
    }

    const fetchSlots = async () => {
      try {
        setLoading(true);
        setError(null);
        const dateStr = selectedDate.toISOString().split('T')[0];
        const result = await availabilityApi.getSlots(dateStr, podUrl);
        setSlots(result.slots || []);
      } catch (err) {
        console.error('Failed to fetch slots:', err);
        setError(err.message);
        setSlots([]);
      } finally {
        setLoading(false);
      }
    };

    fetchSlots();
  }, [selectedDate, isAuthenticated, podUrl]);

  return { slots, loading, error };
}

// =============================================================================
// Identity Providers Hook
// =============================================================================

export function useIdentityProviders() {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const result = await authApi.getProviders();
        setProviders(result.providers || []);
      } catch (err) {
        console.error('Failed to fetch providers:', err);
        // Fallback providers
        setProviders([
          { name: 'Inrupt PodSpaces', url: 'https://login.inrupt.com' },
          { name: 'solidcommunity.net', url: 'https://solidcommunity.net' },
        ]);
      } finally {
        setLoading(false);
      }
    };

    fetchProviders();
  }, []);

  return { providers, loading };
}

// =============================================================================
// Helpers
// =============================================================================

function getDefaultAvailability() {
  return {
    eventDuration: 30,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    name: '',
    email: '',
    bookingSlug: '',
    bufferBefore: 0,
    bufferAfter: 0,
    minNotice: 1,
    maxAdvance: 60,
    days: {
      monday: { enabled: true, start: '09:00', end: '17:00' },
      tuesday: { enabled: true, start: '09:00', end: '17:00' },
      wednesday: { enabled: true, start: '09:00', end: '17:00' },
      thursday: { enabled: true, start: '09:00', end: '17:00' },
      friday: { enabled: true, start: '09:00', end: '17:00' },
      saturday: { enabled: false, start: '09:00', end: '17:00' },
      sunday: { enabled: false, start: '09:00', end: '17:00' },
    },
  };
}

export default {
  AuthProvider,
  useAuth,
  useAvailability,
  useBookings,
  useAvailableSlots,
  useIdentityProviders,
};
