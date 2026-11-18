import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsCard from './SettingsCard';

const saved = {
  organizerName: 'Uma Organizer',
  organizerEmail: 'uma@example.org',
  eventDuration: 30,
  timezone: 'Europe/Paris',
  bookingSlug: 'uma',
};

function setup(props = {}) {
  const onSave = props.onSave ?? vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<SettingsCard availability={saved} onSave={onSave} {...props} />);
  return { user, onSave };
}

describe('SettingsCard', () => {
  it('shows the saved settings', () => {
    setup();
    expect(screen.getByLabelText('Your name')).toHaveValue('Uma Organizer');
    expect(screen.getByLabelText('Email for booking notifications')).toHaveValue('uma@example.org');
    expect(screen.getByLabelText('Meeting length')).toHaveValue('30');
    expect(screen.getByLabelText('Booking link')).toHaveValue('uma');
  });

  it('only allows saving once something changed', async () => {
    const { user } = setup();
    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Meeting length'), '45');
    expect(save).toBeEnabled();
  });

  it('saves the changed fields', async () => {
    const { user, onSave } = setup();
    await user.clear(screen.getByLabelText('Your name'));
    await user.type(screen.getByLabelText('Your name'), 'Uma O.');
    await user.selectOptions(screen.getByLabelText('Meeting length'), '45');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      organizerName: 'Uma O.', eventDuration: 45, bookingSlug: 'uma', timezone: 'Europe/Paris',
    }));
    expect(await screen.findByRole('button', { name: /Saved/ })).toBeInTheDocument();
  });

  it('shows how a new booking link will be saved, asks before changing it, and saves it cleaned up', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { user, onSave } = setup();
    const link = screen.getByLabelText('Booking link');
    await user.clear(link);
    await user.type(link, 'Uma Meetings!');
    expect(screen.getByText(/Will be saved as \/book\/uma-meetings/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(confirm).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ bookingSlug: 'uma-meetings' }));
  });

  it("doesn't save when the link change isn't confirmed", async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { user, onSave } = setup();
    await user.type(screen.getByLabelText('Booking link'), '-new');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses a booking link with no letters or digits', async () => {
    const { user, onSave } = setup();
    const link = screen.getByLabelText('Booking link');
    await user.clear(link);
    await user.type(link, '!!!');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByRole('alert')).toHaveTextContent('needs at least one letter or digit');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows why a save failed, next to the form', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onSave = vi.fn().mockRejectedValue(new Error('This booking URL is already taken. Please choose a different one.'));
    const { user } = setup({ onSave });
    await user.type(screen.getByLabelText('Booking link'), '-taken');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already taken');
  });

  it('says existing meetings keep their time when the timezone changes', async () => {
    const { user } = setup();
    expect(screen.getByText('Your weekly hours are in this timezone.')).toBeInTheDocument();
    const tz = screen.getByLabelText('Timezone');
    await user.click(tz);
    await user.type(tz, 'Tokyo');
    await user.keyboard('{Enter}');
    expect(screen.getByText(/Existing meetings keep their time/)).toBeInTheDocument();
  });
});
