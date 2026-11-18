import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ConfirmationView from './ConfirmationView';

const noop = vi.fn();
const props = { setView: noop, setBookedEvent: noop, setSelectedDate: noop, setSelectedSlot: noop, setBookingForm: noop };

describe('ConfirmationView', () => {
  it("shows the meeting's real length", () => {
    render(<ConfirmationView {...props} bookedEvent={{ date: 'Monday, September 16, 2030', startTime: '10:00 AM', duration: 45 }} />);
    expect(screen.getByText('45 min')).toBeInTheDocument();
  });

  it('offers the calendar file when there is one', () => {
    render(<ConfirmationView {...props} bookedEvent={{ date: 'Monday', startTime: '10:00 AM', duration: 30, icsUrl: 'blob:http://localhost/abc' }} />);
    const link = screen.getByRole('link', { name: /Download \.ics/ });
    expect(link).toHaveAttribute('href', 'blob:http://localhost/abc');
    expect(link).toHaveAttribute('download', 'meeting.ics');
  });

  it('has no download when there is no calendar file', () => {
    render(<ConfirmationView {...props} bookedEvent={{ date: 'Monday', startTime: '10:00 AM', duration: 30 }} />);
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('frees a calendar file made in the browser when it is no longer shown', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { unmount } = render(<ConfirmationView {...props} bookedEvent={{ date: 'Monday', startTime: '10:00 AM', icsUrl: 'blob:http://localhost/abc' }} />);
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/abc');
  });

  it('only links back to the dashboard for the organizer', () => {
    render(<ConfirmationView {...props} isPublic bookedEvent={{ date: 'Monday', startTime: '10:00 AM' }} />);
    expect(screen.queryByRole('button', { name: 'Dashboard' })).not.toBeInTheDocument();
  });
});
