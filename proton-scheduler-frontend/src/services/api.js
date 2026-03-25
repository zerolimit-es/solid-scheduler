/**
 * API Service
 *
 * Centralised HTTP layer and endpoint definitions.
 * Extracted from App.jsx — was previously ~175 lines inlined in the component file.
 */

const API_BASE_URL = "";

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getDefaultAvailability() {
  return {
    eventDuration: 30,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    name: "",
    email: "",
    bookingSlug: "",
    monday: { enabled: true, start: "09:00", end: "17:00" },
    tuesday: { enabled: true, start: "09:00", end: "17:00" },
    wednesday: { enabled: true, start: "09:00", end: "17:00" },
    thursday: { enabled: true, start: "09:00", end: "17:00" },
    friday: { enabled: true, start: "09:00", end: "17:00" },
    saturday: { enabled: false, start: "09:00", end: "17:00" },
    sunday: { enabled: false, start: "09:00", end: "17:00" },
  };
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function apiFetch(endpoint, options = {}) {
  const url = `${API_BASE_URL}${endpoint}`;
  const config = {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  };

  try {
    const response = await fetch(url, config);
    const contentType = response.headers.get('content-type');

    if (contentType?.includes('text/calendar')) {
      if (!response.ok) throw new ApiError('Failed to download', response.status);
      return response.text();
    }

    const data = await response.json();
    if (!response.ok) {
      throw new ApiError(data.message || data.error || 'Request failed', response.status, data);
    }
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.message || 'Network error', 0);
  }
}

// ── Endpoint Definitions ─────────────────────────────────────────────────────

export const api = {
  auth: {
    getStatus: () => apiFetch('/api/auth/status'),
    getLoginUrl: (idp, returnTo) => {
      const params = new URLSearchParams();
      if (idp) params.set('oidcIssuer', idp);
      if (returnTo) params.set('returnTo', returnTo);
      return `${API_BASE_URL}/api/auth/login?${params}`;
    },
    getProviders: () => apiFetch('/api/auth/providers'),
    logout: () => apiFetch('/api/auth/logout', { method: 'POST' }),
    setPodUrl: (podUrl) => apiFetch('/api/auth/pod-url', { method: 'PUT', body: JSON.stringify({ podUrl }) }),
  },
  availability: {
    get: (pod) => apiFetch(`/api/availability${pod ? `?pod=${encodeURIComponent(pod)}` : ''}`),
    update: (data, pod) => apiFetch(`/api/availability${pod ? `?pod=${encodeURIComponent(pod)}` : ''}`, {
      method: 'PUT', body: JSON.stringify(data)
    }),
    getSlots: (date, pod) => {
      const params = new URLSearchParams({ date });
      if (pod) params.set('pod', pod);
      return apiFetch(`/api/availability/slots?${params}`);
    },
    createPublic: (data, pod) => apiFetch(`/api/availability/public${pod ? `?pod=${encodeURIComponent(pod)}` : ''}`, {
      method: 'POST', body: JSON.stringify(data)
    }),
  },
  passkey: {
    registerOptions: () => apiFetch('/api/auth/passkey/register-options'),
    registerVerify: (body, deviceName) => apiFetch('/api/auth/passkey/register-verify', {
      method: 'POST', body: JSON.stringify({ body, deviceName }),
    }),
    authOptions: (opts) => apiFetch('/api/auth/passkey/auth-options', opts),
    authVerify: (body) => apiFetch('/api/auth/passkey/auth-verify', {
      method: 'POST', body: JSON.stringify({ body }),
    }),
    list: () => apiFetch('/api/auth/passkey/list'),
    remove: (id) => apiFetch(`/api/auth/passkey/${id}`, { method: 'DELETE' }),
  },
  calendar: {
    getEvents: (from, to) => apiFetch(`/api/calendar/events?from=${from}&to=${to}`),
    createEvent: (data) => apiFetch('/api/calendar/events', { method: 'POST', body: JSON.stringify(data) }),
    updateEvent: (id, data) => apiFetch(`/api/calendar/events/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteEvent: (id) => apiFetch(`/api/calendar/events/${id}`, { method: 'DELETE' }),
    importIcs: (icsContent) => apiFetch('/api/calendar/import', { method: 'POST', body: JSON.stringify({ icsContent }) }),
    getFeedToken: () => apiFetch('/api/calendar/feed-token'),
    regenerateFeedToken: () => apiFetch('/api/calendar/feed-token/regenerate', { method: 'POST' }),
  },
  bookings: {
    list: (opts = {}) => {
      const params = new URLSearchParams();
      Object.entries(opts).forEach(([k, v]) => v && params.set(k, v));
      return apiFetch(`/api/bookings${params.toString() ? `?${params}` : ''}`);
    },
    getUpcoming: (limit, pod) => {
      const params = new URLSearchParams({ limit: String(limit || 10) });
      if (pod) params.set('pod', pod);
      return apiFetch(`/api/bookings/upcoming?${params}`);
    },
    getExpanded: (from, to, pod) => {
      const params = new URLSearchParams({ from, to });
      if (pod) params.set('pod', pod);
      return apiFetch(`/api/bookings/expanded?${params}`);
    },
    getStats: (pod) => apiFetch(`/api/bookings/stats${pod ? `?pod=${encodeURIComponent(pod)}` : ''}`),
    getPresets: () => apiFetch('/api/bookings/presets'),
    create: (data, pod) => apiFetch(`/api/bookings${pod ? `?pod=${encodeURIComponent(pod)}` : ''}`, {
      method: 'POST', body: JSON.stringify(data)
    }),
    cancel: (id, opts, pod) => apiFetch(`/api/bookings/${id}${pod ? `?pod=${encodeURIComponent(pod)}` : ''}`, {
      method: 'DELETE', body: JSON.stringify(opts || {})
    }),
    getIcsUrl: (id, pod) => `${API_BASE_URL}/api/bookings/${id}/ics${pod ? `?pod=${encodeURIComponent(pod)}` : ''}`,
  },
};

// ── Recurrence Presets ───────────────────────────────────────────────────────

export const RECURRENCE_PRESETS = [
  { id: 'none', label: 'Does not repeat', value: null },
  { id: 'daily', label: 'Daily', value: { frequency: 'DAILY' } },
  { id: 'weekdays', label: 'Every weekday (Mon-Fri)', value: { frequency: 'WEEKLY', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'] } },
  { id: 'weekly', label: 'Weekly', value: { frequency: 'WEEKLY' } },
  { id: 'biweekly', label: 'Every 2 weeks', value: { frequency: 'WEEKLY', interval: 2 } },
  { id: 'monthly', label: 'Monthly', value: { frequency: 'MONTHLY' } },
  { id: 'yearly', label: 'Yearly', value: { frequency: 'YEARLY' } },
];

// ── Local Slot Generation ────────────────────────────────────────────────────

export function generateLocalSlots(date, availability) {
  if (!availability) return [];
  const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const dayName = dayNames[date.getDay()];
  const daySettings = availability.days?.[dayName] || availability[dayName];
  if (!daySettings?.enabled) return [];

  const [startHour, startMin] = daySettings.start.split(":").map(Number);
  const [endHour, endMin] = daySettings.end.split(":").map(Number);
  const duration = availability.eventDuration || 30;

  const now = new Date();
  const isToday = date.getFullYear() === now.getFullYear() &&
                  date.getMonth() === now.getMonth() &&
                  date.getDate() === now.getDate();
  const nowMinutes = isToday ? now.getHours() * 60 + now.getMinutes() : 0;

  const slots = [];
  for (let h = startHour; h < endHour || (h === endHour && 0 < endMin); h++) {
    for (let m = (h === startHour ? startMin : 0); m < 60; m += duration) {
      if (h * 60 + m + duration > endHour * 60 + endMin) break;
      if (isToday && h * 60 + m <= nowMinutes + 15) continue;
      const time = h.toString().padStart(2, "0") + ":" + m.toString().padStart(2, "0");
      slots.push({
        time,
        display: new Date(2024, 0, 1, h, m).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
        booked: false,
      });
    }
  }
  return slots;
}
