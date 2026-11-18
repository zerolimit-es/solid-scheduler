import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import BookingForm from './BookingForm';

/** The form with real state, so typing shows up like in the app. */
function Harness({ allowRepeat = false, handleBooking = vi.fn(), setView = vi.fn() }) {
  const [bookingForm, setBookingForm] = React.useState({ name: '', email: '', notes: '', recurrence: null });
  return (
    <BookingForm
      selectedDate={new Date(2030, 8, 16)}
      selectedSlot={{ time: '09:30', display: '9:30 AM' }}
      availability={{ eventDuration: 30 }}
      bookingForm={bookingForm}
      setBookingForm={setBookingForm}
      handleBooking={handleBooking}
      saving={false}
      setView={setView}
      allowRepeat={allowRepeat}
    />
  );
}

describe('BookingForm', () => {
  it('names every field, so screen readers announce them', () => {
    render(<Harness allowRepeat />);
    expect(screen.getByRole('textbox', { name: 'Your Name *' })).toBeRequired();
    expect(screen.getByRole('textbox', { name: 'Email Address *' })).toBeRequired();
    expect(screen.getByRole('textbox', { name: 'Notes (optional)' })).not.toBeRequired();
    expect(screen.getByRole('combobox', { name: 'Repeat' })).toBeInTheDocument();
  });

  it('focuses a field when its label is clicked', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText('Email Address *'));
    expect(screen.getByLabelText('Email Address *')).toHaveFocus();
  });

  it('books with Enter once the required fields are filled in', async () => {
    const user = userEvent.setup();
    const handleBooking = vi.fn();
    render(<Harness handleBooking={handleBooking} />);
    await user.type(screen.getByLabelText('Your Name *'), 'Nia Visitor');
    await user.type(screen.getByLabelText('Email Address *'), 'nia@example.com{Enter}');
    expect(handleBooking).toHaveBeenCalledTimes(1);
  });

  it("doesn't book with a missing name or an invalid email", async () => {
    const user = userEvent.setup();
    const handleBooking = vi.fn();
    render(<Harness handleBooking={handleBooking} />);
    await user.type(screen.getByLabelText('Email Address *'), 'nia@example.com');
    await user.click(screen.getByRole('button', { name: 'Confirm Booking' }));
    expect(handleBooking).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Your Name *'), 'Nia');
    await user.clear(screen.getByLabelText('Email Address *'));
    await user.type(screen.getByLabelText('Email Address *'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Confirm Booking' }));
    expect(handleBooking).not.toHaveBeenCalled();
  });

  it('goes back without booking', async () => {
    const user = userEvent.setup();
    const handleBooking = vi.fn();
    const setView = vi.fn();
    render(<Harness handleBooking={handleBooking} setView={setView} />);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(setView).toHaveBeenCalledWith('booking');
    expect(handleBooking).not.toHaveBeenCalled();
  });

  it('asks how many times a repeating meeting happens', async () => {
    const user = userEvent.setup();
    render(<Harness allowRepeat />);
    await user.selectOptions(screen.getByLabelText('Repeat'), 'weekly');
    expect(screen.getByRole('spinbutton', { name: 'Number of occurrences' })).toHaveValue(4);
  });
});
