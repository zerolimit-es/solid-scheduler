import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useBookings from './useBookings';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const everyDay = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map((d) => [d, { enabled: true, start: '09:00', end: '17:00' }]));
const availability = { timezone: 'Europe/Paris', eventDuration: 30, ...everyDay };
const slotsFor = (date) => ({ date, slots: [{ time: '09:00', displayTime: '9:00 AM', isBooked: false }] });

function setup(fetchImpl) {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  const setView = vi.fn();
  const setError = vi.fn();
  const hook = renderHook(() => useBookings({ user: null, publicSlug: 'uma', availability, setView, setError }));
  return { ...hook, setView, setError };
}

describe('useBookings (public page)', () => {
  it('loads the times for the first open day', async () => {
    const { result } = setup(async (url) => json(slotsFor(new URL(url, 'http://x').searchParams.get('date'))));
    await waitFor(() => expect(result.current.slots).toHaveLength(1));
    expect(result.current.slots[0]).toMatchObject({ time: '09:00', display: '9:00 AM', booked: false });
    expect(result.current.slotsError).toBeNull();
  });

  it("shows an error, not made-up times, when they can't be loaded, and loads them on retry", async () => {
    let fail = true;
    const { result } = setup(async (url) => (fail
      ? json({ error: 'Failed to get slots' }, 500)
      : json(slotsFor(new URL(url, 'http://x').searchParams.get('date')))));
    await waitFor(() => expect(result.current.slotsError).toMatch(/couldn't be loaded/));
    expect(result.current.slots).toEqual([]);

    fail = false;
    act(() => result.current.retrySlots());
    await waitFor(() => expect(result.current.slots).toHaveLength(1));
    expect(result.current.slotsError).toBeNull();
  });

  it('keeps the times of the day picked last when an earlier answer arrives late', async () => {
    const pending = {};
    const { result } = setup((url) => {
      const date = new URL(url, 'http://x').searchParams.get('date');
      return new Promise((resolve) => { pending[date] = () => resolve(json({ date, slots: [{ time: date, displayTime: date, isBooked: false }] })); });
    });
    await waitFor(() => expect(Object.keys(pending)).toHaveLength(1));
    const first = Object.keys(pending)[0];

    act(() => result.current.setSelectedDate(new Date(2031, 0, 6)));
    await waitFor(() => expect(pending['2031-01-06']).toBeDefined());
    await act(async () => { pending['2031-01-06'](); });
    await act(async () => { pending[first](); }); // the earlier day answers last
    expect(result.current.slots.map((s) => s.time)).toEqual(['2031-01-06']);
  });

  it('says what was wrong with each field when a booking is refused', async () => {
    const { result, setError } = setup(async (url, init) => (init?.method === 'POST'
      ? json({ error: 'Validation failed', fields: { email: 'Invalid email address' } }, 400)
      : json(slotsFor('2030-09-16'))));
    await waitFor(() => expect(result.current.slots).toHaveLength(1));
    act(() => {
      result.current.setSelectedSlot({ time: '09:00' });
      result.current.setBookingForm({ name: 'Nia', email: 'not-an-email', notes: '', recurrence: null });
    });
    await act(async () => { await result.current.handleBooking(); });
    expect(setError).toHaveBeenLastCalledWith('Invalid email address');
  });

  it('offers the calendar file the server sent back', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/ics');
    const { result, setView } = setup(async (url, init) => (init?.method === 'POST'
      ? json({ success: true, booking: { id: 'b1', duration: 30 }, icsContent: 'BEGIN:VCALENDAR' }, 201)
      : json(slotsFor('2030-09-16'))));
    await waitFor(() => expect(result.current.slots).toHaveLength(1));
    act(() => {
      result.current.setSelectedSlot({ time: '09:00' });
      result.current.setBookingForm({ name: 'Nia', email: 'nia@example.com', notes: '', recurrence: null });
    });
    await act(async () => { await result.current.handleBooking(); });
    expect(result.current.bookedEvent).toMatchObject({ id: 'b1', icsUrl: 'blob:http://localhost/ics' });
    expect(setView).toHaveBeenCalledWith('confirmation');
  });
});
