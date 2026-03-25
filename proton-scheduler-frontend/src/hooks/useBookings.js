/**
 * useBookings Hook
 *
 * Manages the booking flow: calendar navigation, slot fetching,
 * booking form state, and booking creation.
 * Extracted from App.jsx.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { api, generateLocalSlots } from '../services/api';

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

  // Form
  const [bookingForm, setBookingForm] = useState({ name: '', email: '', notes: '', recurrence: null, teamMemberId: null });
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
    const today = new Date();
    today.setHours(0,0,0,0);
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
    if (!selectedDate) { setSlots([]); return; }
    if (!publicSlug && !user) { setSlots([]); return; }

    const fetchSlots = async () => {
      setSlotsLoading(true);
      try {
        const dateStr = [
          selectedDate.getFullYear(),
          String(selectedDate.getMonth() + 1).padStart(2, '0'),
          String(selectedDate.getDate()).padStart(2, '0'),
        ].join('-');

        let fetchedSlots = [];
        if (publicSlug) {
          const res = await fetch(`/api/public/${publicSlug}/slots?date=${dateStr}`);
          const data = await res.json();
          fetchedSlots = (data.slots || []).map(s => ({ time: s.time, display: s.displayTime, booked: s.isBooked }));
        } else {
          const result = await api.availability.getSlots(dateStr, user.pods[0]);
          fetchedSlots = (result.slots || [])
              .map(s => ({ time: s.time, display: s.displayTime || s.display, booked: s.isBooked || s.booked || false }));
        }

        // Filter out past time slots for today (applies to both public and auth'd)
        const now = new Date();
        const isToday = selectedDate.getFullYear() === now.getFullYear() &&
                        selectedDate.getMonth() === now.getMonth() &&
                        selectedDate.getDate() === now.getDate();
        if (isToday) {
          const nowMin = now.getHours() * 60 + now.getMinutes();
          fetchedSlots = fetchedSlots.filter(s => {
            const [h, m] = s.time.split(':').map(Number);
            return h * 60 + m > nowMin + 15;
          });
        }
        setSlots(fetchedSlots);

        // Auto-advance: if no available slots and this was auto-selected, try next day
        const available = fetchedSlots.filter(s => !s.booked);
        if (available.length === 0 && autoSelectStartRef.current >= 0) {
          const today = new Date(); today.setHours(0,0,0,0);
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
        setSlots(generateLocalSlots(selectedDate, availability));
      } finally {
        setSlotsLoading(false);
      }
    };

    fetchSlots();
  }, [selectedDate, user, publicSlug, availability]);

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
            recurrence: bookingForm.recurrence,
            ...(bookingForm.teamMemberId ? { teamMemberId: bookingForm.teamMemberId } : {}),
          }),
        });
        result = await res.json();
        if (!res.ok) {
          if (res.status === 429) {
            throw new Error(result.message || 'This booking page has reached its monthly limit. Please try again next month.');
          }
          throw new Error(result.error || 'Booking failed');
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

      setBookedEvent(result.booking);
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
    setBookingForm({ name: '', email: '', notes: '', recurrence: null, teamMemberId: null });
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
