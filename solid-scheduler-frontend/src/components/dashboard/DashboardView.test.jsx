import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import DashboardView from './DashboardView';

// Cards that load their own data are tested on their own
vi.mock('./BlockedTimeCard', () => ({ default: () => null }));
vi.mock('./CalendarFeedCard', () => ({ default: () => null }));
vi.mock('./SecurityCard', () => ({ default: () => null }));

const saved = { timezone: 'Europe/Paris', eventDuration: 30, bookingSlug: 'uma', organizerName: 'Uma' };

function renderDashboard(props = {}) {
  return render(
    <DashboardView
      availability={saved}
      savedAvailability={saved}
      bookings={[]}
      setBookings={vi.fn()}
      stats={{ thisWeek: 1, thisMonth: 2, upcoming: 3 }}
      podStatus={{ connected: true }}
      linkCopied={false}
      setLinkCopied={vi.fn()}
      saving={false}
      saved={false}
      handleSaveAvailability={vi.fn()}
      handleSaveSettings={vi.fn()}
      setAvailability={vi.fn()}
      setError={vi.fn()}
      {...props}
    />,
  );
}

const meetingRow = (title) => screen.getByText(title).closest('div').parentElement;

describe('DashboardView', () => {
  it('shows the saved booking link', () => {
    renderDashboard();
    expect(screen.getByText(`${window.location.origin}/book/uma`)).toBeInTheDocument();
  });

  it("shows upcoming meetings in the account's timezone, whatever the browser's", () => {
    // 20:00 UTC is Monday 22:00 in Paris (Tuesday 05:00 in Tokyo)
    renderDashboard({ bookings: [{ id: 'a', title: 'Late call', start: '2030-09-16T20:00:00.000Z', attendee: { name: 'Vik' } }] });
    const row = within(meetingRow('Late call').parentElement);
    expect(row.getByText('Mon')).toBeInTheDocument();
    expect(row.getByText('16')).toBeInTheDocument();
    expect(row.getByText(/10:00\s?PM · Vik/)).toBeInTheDocument();
  });

  it('shows a local clock time as it is', () => {
    renderDashboard({ bookings: [{ id: 'b', title: 'Morning', start: '2030-09-16 09:30', attendee: 'Ana' }] });
    expect(within(meetingRow('Morning').parentElement).getByText(/9:30\s?AM · Ana/)).toBeInTheDocument();
  });

  it('says when there is nothing coming up', () => {
    renderDashboard();
    expect(screen.getByText('No upcoming meetings')).toBeInTheDocument();
  });
});
