import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingView from './BookingView';

const week = (enabled) => Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map((d) => [d, { enabled: enabled.includes(d), start: '09:00', end: '17:00' }]));

function setup(props = {}) {
  const handlers = {
    setCurrentMonth: vi.fn(), setSelectedDate: vi.fn(), setSelectedSlot: vi.fn(),
    retrySlots: vi.fn(), setView: vi.fn(),
  };
  render(
    <BookingView
      availability={{ timezone: 'Europe/Paris', eventDuration: 30, ...week(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']) }}
      currentMonth={new Date(2030, 8, 1)}
      selectedDate={null}
      selectedSlot={null}
      slots={[]}
      slotsLoading={false}
      slotsError={null}
      {...handlers}
      {...props}
    />,
  );
  return { user: userEvent.setup(), ...handlers };
}

describe('BookingView', () => {
  it('offers the working days as buttons, from the keyboard too', async () => {
    const { user, setSelectedDate } = setup();
    const monday = screen.getByRole('button', { name: 'Monday, September 16' });
    expect(monday).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Saturday, September 14, unavailable' })).toBeDisabled();

    monday.focus();
    await user.keyboard('{Enter}');
    expect(setSelectedDate).toHaveBeenCalledWith(new Date(2030, 8, 16));
  });

  it("greys out days before the organizer's today", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Tuesday 17 Sept, 01:00 in Paris
    vi.setSystemTime(new Date('2030-09-16T23:00:00Z'));
    setup();
    expect(screen.getByRole('button', { name: 'Monday, September 16, unavailable' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Tuesday, September 17' })).toBeEnabled();
  });

  it('lists the times, with taken ones disabled, and selects one', async () => {
    const { user, setSelectedSlot } = setup({
      selectedDate: new Date(2030, 8, 16),
      slots: [
        { time: '09:00', display: '9:00 AM', booked: true },
        { time: '09:30', display: '9:30 AM', booked: false },
      ],
    });
    expect(screen.getByRole('button', { name: '9:00 AM, taken' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '9:30 AM' }));
    expect(setSelectedSlot).toHaveBeenCalledWith(expect.objectContaining({ time: '09:30' }));
  });

  it("says when times couldn't be loaded, without listing any, and lets the visitor try again", async () => {
    const { user, retrySlots } = setup({
      selectedDate: new Date(2030, 8, 16),
      slots: [],
      slotsError: "The available times couldn't be loaded.",
    });
    expect(screen.getByRole('alert')).toHaveTextContent("couldn't be loaded");
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retrySlots).toHaveBeenCalled();
  });

  it('moves between months', async () => {
    const { user, setCurrentMonth } = setup();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(setCurrentMonth).toHaveBeenCalledWith(new Date(2030, 9, 1));
  });
});
