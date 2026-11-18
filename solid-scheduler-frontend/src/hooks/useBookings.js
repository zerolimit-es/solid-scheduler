/**
 * useBookings Hook
 *
 * Manages the booking flow: calendar navigation, slot fetching,
 * booking form state, and booking creation.
 * Extracted from App.jsx.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../services/api';
import { organizerToday } from '../utils/organizerDate';

/**
 * @param {Object}  options
 * @param {Object}  options.user          - Authenticated user (null for public)
 * @param {string}  options.publicSlug    - Public booking page slug (null for auth'd)
 * @param {Object}  options.availability  - Current availability settings
 * @param {Function} options.setView      - View setter (to navigate to confirmation)
 * @param {Function} options.setError     - Error setter
 * @param {Function} [options.onBookingCreated] - Called after successful booking (e.g. to refresh stats)
 */
export default function useBookings({ user, publicSlug, availability, setView, setError, onBookingCreated }) {
  // Calendar
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);

  // Slots
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(null);
  const [slotsRetry, setSlotsRetry] = useState(0);

  // Form
  const [bookingForm, setBookingForm] = useState({ name: '', email: '', notes: '', recurrence: null });
  const [bookedEvent, setBookedEvent] = useState(null);
  const [saving, setSaving] = useState(false);

  // ── Auto-select first available date ────────────────────────────────────
  const autoSelectStartRef = useRef(0); // day offset to start searching from

  const initialSelectDone = useRef(false);

  useEffect(() => {
    // Only auto-select on initial availability load, not on every re-render
    if (initialSelectDone.current) return;
    if (!availability) return;
    initialSelectDone.current = true;

    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const today = organizerToday(availability.timezone);
    // Search up to 90 days ahead for the first enabled day
    for (let i = 0; i < 90; i++) {
      const candidate = new Date(today);
      candidate.setDate(today.getDate() + i);
      const dayName = dayNames[candidate.getDay()];
      if (availability[dayName]?.enabled) {
        setCurrentMonth(new Date(candidate.getFullYear(), candidate.getMonth(), 1));
        setSelectedDate(candidate);
        break;
      }
    }
  }, [availability]);

  // ── Fetch slots when date selected ─────────────────────────────────────

  useEffect(() => {
    if (!selectedDate) { setSlots([]); setSlotsError(null); return; }
    if (!publicSlug && !user) { setSlots([]); setSlotsError(null); return; }

    // A slower answer for a date picked earlier must not replace this one
    let current = true;

    const fetchSlots = async () => {
      setSlotsLoading(true);
      setSlotsError(null);
      setSelectedSlot(null);
      try {
        const dateStr = [
          selectedDate.getFullYear(),
          String(selectedDate.getMonth() + 1).padStart(2, '0'),
          String(selectedDate.getDate()).padStart(2, '0'),
        ].join('-');

        let fetchedSlots = [];
        if (publicSlug) {
          const res = await fetch(`/api/public/${publicSlug}/slots?date=${dateStr}`);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.message || data.error || 'Request failed');
          fetchedSlots = (data.slots || []).map(s => ({ time: s.time, display: s.displayTime, booked: s.isBooked }));
        } else {
          const result = await api.availability.getSlots(dateStr, user.pods[0]);
          fetchedSlots = (result.slots || [])
              .map(s => ({ time: s.time, display: s.displayTime || s.display, booked: s.isBooked || s.booked || false }));
        }

        // The server already leaves out times that have passed, judged in the
        // organizer's timezone. Filtering again by this browser's clock would
        // hide valid slots from visitors in timezones ahead of the organizer.
        if (!current) return;
        setSlots(fetchedSlots);

        // Auto-advance: if no available slots and this was auto-selected, try next day
        const available = fetchedSlots.filter(s => !s.booked);
        if (available.length === 0 && autoSelectStartRef.current >= 0) {
          const today = organizerToday(availability?.timezone);
          const daysDiff = Math.round((selectedDate - today) / 86400000);
          autoSelectStartRef.current = daysDiff + 1;
          // Re-trigger auto-select by bumping availability dep (use a state toggle)
          const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
          for (let i = autoSelectStartRef.current; i < 90; i++) {
            const candidate = new Date(today);
            candidate.setDate(today.getDate() + i);
            if (availability?.[dayNames[candidate.getDay()]]?.enabled) {
              setCurrentMonth(new Date(candidate.getFullYear(), candidate.getMonth(), 1));
              setSelectedDate(candidate);
              return; // will re-trigger this effect
            }
          }
        }
        // Stop auto-advancing once user manually picks or slots are found
        autoSelectStartRef.current = -1;
      } catch (err) {
        console.error('Failed to fetch slots:', err);
        if (!current) return;
        // Don't guess: times worked out here would leave out bookings and
        // blocked time, and booking one would then be refused
        setSlots([]);
        setSlotsError("The available times couldn't be loaded.");
        autoSelectStartRef.current = -1;
      } finally {
        if (current) setSlotsLoading(false);
      }
    };

    fetchSlots();
    return () => { current = false; };
  }, [selectedDate, user, publicSlug, availability, slotsRetry]);

  // Wrap setSelectedDate so manual clicks disable auto-advance
  const selectDate = (date) => {
    autoSelectStartRef.current = -1;
    setSelectedDate(date);
  };

  // ── Calendar day grid ──────────────────────────────────────────────────

  const calendarDays = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startPadding = firstDay.getDay();
    const days = [];

    for (let i = startPadding - 1; i >= 0; i--) {
      days.push({ date: new Date(year, month, -i), isCurrentMonth: false });
    }
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push({ date: new Date(year, month, i), isCurrentMonth: true });
    }
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      days.push({ date: new Date(year, month + 1, i), isCurrentMonth: false });
    }
    return days;
  }, [currentMonth]);

  // ── Create booking ─────────────────────────────────────────────────────

  const handleBooking = async () => {
    if (!selectedDate || !selectedSlot || !bookingForm.name || !bookingForm.email) return;
    setSaving(true);
    setError(null);
    try {
      let result;
      const dateStr = [
        selectedDate.getFullYear(),
        String(selectedDate.getMonth() + 1).padStart(2, '0'),
        String(selectedDate.getDate()).padStart(2, '0'),
      ].join('-');

      if (publicSlug) {
        const res = await fetch(`/api/public/${publicSlug}/book`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date: dateStr,
            time: selectedSlot.time,
            name: bookingForm.name,
            email: bookingForm.email,
            notes: bookingForm.notes,
          }),
        });
        result = await res.json();
        if (!res.ok) {
          // A validation error names what is wrong with each field
          const fieldErrors = result.fields && typeof result.fields === 'object'
            ? Object.values(result.fields).join(' ') : '';
          throw new Error(fieldErrors || result.message || result.error || 'Booking failed');
        }
      } else {
        result = await api.bookings.create({
          date: dateStr,
          time: selectedSlot.time,
          name: bookingForm.name,
          email: bookingForm.email,
          notes: bookingForm.notes,
          recurrence: bookingForm.recurrence,
        }, user.pods[0]);
      }

      // The calendar file: the one the server just made, or for a booking
      // saved straight to the Pod, the signed-in download
      const booked = { ...result.booking };
      if (result.icsContent) {
        booked.icsUrl = URL.createObjectURL(new Blob([result.icsContent], { type: 'text/calendar' }));
      } else if (!publicSlug && booked.id) {
        booked.icsUrl = api.bookings.getIcsUrl(booked.id, user.pods[0]);
      }
      setBookedEvent(booked);
      setView('confirmation');

      if (onBookingCreated) onBookingCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Reset ──────────────────────────────────────────────────────────────

  const resetBooking = () => {
    setSelectedDate(null);
    setSelectedSlot(null);
    setBookingForm({ name: '', email: '', notes: '', recurrence: null });
    setBookedEvent(null);
    setView('dashboard');
  };

  return {
    // Calendar
    currentMonth,
    setCurrentMonth,
    calendarDays,
    selectedDate,
    setSelectedDate: selectDate,
    selectedSlot,
    setSelectedSlot,
    // Slots
    slots,
    slotsLoading,
    slotsError,
    retrySlots: () => setSlotsRetry((n) => n + 1),
    // Booking
    bookingForm,
    setBookingForm,
    bookedEvent,
    setBookedEvent,
    saving,
    setSaving,
    handleBooking,
    resetBooking,
  };
}
