import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BlockedTimeCard from './BlockedTimeCard';
import { api } from '../../services/api';

vi.mock('../../services/api', () => ({
  api: { calendar: { getEvents: vi.fn(), createEvent: vi.fn(), deleteEvent: vi.fn(), importIcs: vi.fn() } },
}));

const listed = (events) => ({ timezone: 'Europe/Paris', from: '2030-09-16', to: '2030-12-15', events });
const DENTIST = { id: 'e1', title: 'Dentist', start: '2030-09-17 14:00', end: '2030-09-17 15:00', allDay: false, recurrence: null };

beforeEach(() => {
  api.calendar.getEvents.mockResolvedValue(listed([]));
  api.calendar.createEvent.mockResolvedValue({ event: {} });
  api.calendar.deleteEvent.mockResolvedValue({ success: true });
});

async function renderCard() {
  const user = userEvent.setup();
  render(<BlockedTimeCard />);
  await waitForElementToBeRemoved(() => screen.queryByText('Loading blocked time…'));
  return user;
}

describe('BlockedTimeCard', () => {
  it("lists blocked time in the organizer's timezone, a repeating block at its next occurrence", async () => {
    api.calendar.getEvents.mockResolvedValue(listed([
      DENTIST,
      { id: 'e2', title: 'Gym', start: '2020-01-06 07:00', end: '2020-01-06 08:00', recurrence: 'FREQ=WEEKLY;BYDAY=MO',
        next: { start: '2030-09-23 07:00', end: '2030-09-23 08:00' } },
      { id: 'e3', title: 'Old course', start: '2020-01-06 09:00', end: '2020-01-06 10:00', recurrence: 'FREQ=DAILY;COUNT=3', next: null },
      { id: 'e4', title: 'Holiday', start: '2030-10-01 00:00', end: '2030-10-04 00:00', allDay: true },
    ]));
    await renderCard();
    const list = screen.getByRole('list', { name: 'Blocked time' });
    expect(within(list).getByText('Dentist')).toBeInTheDocument();
    expect(within(list).getByText(/Next: .*07:00–08:00/)).toBeInTheDocument();
    expect(within(list).getByText(/Every week/)).toBeInTheDocument();
    expect(within(list).getByText(/– .*, all day/)).toBeInTheDocument();
    expect(within(list).queryByText('Old course')).not.toBeInTheDocument();
    expect(screen.getByText(/\(Europe\/Paris\)/)).toBeInTheDocument();
  });

  it("starts the form on the organizer's today", async () => {
    await renderCard();
    expect(screen.getByLabelText('Date')).toHaveValue('2030-09-16');
  });

  it('blocks a weekly time on the chosen weekday', async () => {
    const user = await renderCard();
    await user.type(screen.getByLabelText('Title'), 'Team call');
    await user.selectOptions(screen.getByLabelText('Repeat'), 'weekly');
    await user.click(screen.getByRole('button', { name: 'Block time' }));
    expect(api.calendar.createEvent).toHaveBeenCalledWith({
      title: 'Team call', start: '2030-09-16 09:00', end: '2030-09-16 10:00', recurrence: 'FREQ=WEEKLY;BYDAY=MO',
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Time blocked');
  });

  it('runs a block past midnight when its end is before its start', async () => {
    const user = await renderCard();
    await user.type(screen.getByLabelText('Title'), 'Night shift');
    await user.clear(screen.getByLabelText('Start time'));
    await user.type(screen.getByLabelText('Start time'), '22:00');
    await user.clear(screen.getByLabelText('End time'));
    await user.type(screen.getByLabelText('End time'), '06:00');
    expect(screen.getByText('(ends the next day)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Block time' }));
    expect(api.calendar.createEvent).toHaveBeenCalledWith(expect.objectContaining({
      start: '2030-09-16 22:00', end: '2030-09-17 06:00',
    }));
  });

  it('blocks a whole day', async () => {
    const user = await renderCard();
    await user.type(screen.getByLabelText('Title'), 'Away');
    await user.click(screen.getByLabelText('All day'));
    await user.click(screen.getByRole('button', { name: 'Block time' }));
    expect(api.calendar.createEvent).toHaveBeenCalledWith({
      title: 'Away', allDay: true, start: '2030-09-16', end: '2030-09-16', recurrence: null,
    });
  });

  it('shows why a block was refused', async () => {
    api.calendar.createEvent.mockRejectedValue(new Error('events can be at most 31 days long'));
    const user = await renderCard();
    await user.type(screen.getByLabelText('Title'), 'Too long');
    await user.click(screen.getByRole('button', { name: 'Block time' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 31 days');
  });

  it('removes a block after confirming', async () => {
    api.calendar.getEvents.mockResolvedValueOnce(listed([DENTIST])).mockResolvedValue(listed([]));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = await renderCard();
    await user.click(screen.getByRole('button', { name: 'Remove Dentist' }));
    expect(api.calendar.deleteEvent).toHaveBeenCalledWith('e1');
    expect(await screen.findByText(/Nothing blocked/)).toBeInTheDocument();
  });

  it('imports a calendar file and says what was skipped', async () => {
    api.calendar.importIcs.mockResolvedValue({ imported: 2, skipped: { past: 1, duplicate: 3 } });
    const user = await renderCard();
    const file = new File(['BEGIN:VCALENDAR\r\nEND:VCALENDAR'], 'cal.ics', { type: 'text/calendar' });
    await user.upload(screen.getByLabelText('Calendar file to import'), file);
    expect(api.calendar.importIcs).toHaveBeenCalledWith('BEGIN:VCALENDAR\r\nEND:VCALENDAR');
    expect(await screen.findByRole('status')).toHaveTextContent('Imported 2 events. Skipped 1 past, 3 already imported.');
  });
});
