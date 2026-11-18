import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CalendarFeedCard from './CalendarFeedCard';
import { api } from '../../services/api';

vi.mock('../../services/api', () => ({
  api: { calendar: { getFeedToken: vi.fn(), regenerateFeedToken: vi.fn() } },
}));

beforeEach(() => {
  api.calendar.getFeedToken.mockResolvedValue({ feedPath: '/cal/old-token.ics' });
  api.calendar.regenerateFeedToken.mockResolvedValue({ feedPath: '/cal/new-token.ics' });
});

describe('CalendarFeedCard', () => {
  it('shows the feed address', async () => {
    render(<CalendarFeedCard setError={vi.fn()} />);
    expect(await screen.findByText(`${window.location.origin}/cal/old-token.ics`)).toBeInTheDocument();
  });

  it('copies it', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<CalendarFeedCard setError={vi.fn()} />);
    await screen.findByText(/old-token/);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/cal/old-token.ics`);
    expect(await screen.findByText('Copied!')).toBeInTheDocument();
  });

  it('makes a new address only after confirming, since the old one stops working', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<CalendarFeedCard setError={vi.fn()} />);
    await screen.findByText(/old-token/);
    const regenerate = screen.getByRole('button', { name: /Create a new URL/ });

    await user.click(regenerate);
    expect(api.calendar.regenerateFeedToken).not.toHaveBeenCalled();

    await user.click(regenerate);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/new-token/)).toBeInTheDocument();
  });

  it("says so when the feed isn't available", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.calendar.getFeedToken.mockRejectedValue(new Error('down'));
    render(<CalendarFeedCard setError={vi.fn()} />);
    expect(await screen.findByText(/isn't available right now/)).toBeInTheDocument();
  });
});
