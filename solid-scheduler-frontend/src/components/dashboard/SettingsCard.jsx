import React from 'react';
import { UserIcon, LoaderIcon, CheckIcon } from '../common/Icons';
import TimezoneSearch from '../common/TimezoneSearch';

const DURATIONS = [15, 20, 30, 45, 60, 90, 120];

const labelCls = 'block text-xs font-medium mb-1.5 text-[var(--theme-text-muted)]';
const hintCls = 'text-[0.6875rem] text-[var(--theme-text-muted)] mt-1 mb-0';

/** The settings this card edits, taken from the saved availability. */
function settingsOf(availability) {
  return {
    organizerName: availability?.organizerName ?? availability?.name ?? '',
    organizerEmail: availability?.organizerEmail ?? availability?.email ?? '',
    eventDuration: Number(availability?.eventDuration) || 30,
    timezone: availability?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    bookingSlug: availability?.bookingSlug || '',
  };
}

/** The booking link as the server will store it. */
const normalizeSlug = (value) =>
  value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

/**
 * Booking page settings: the name and email shown to people who book, the
 * meeting length, the timezone the weekly hours are in, and the booking link.
 */
/** What the email field says about confirmation, for each server status. */
const EMAIL_STATUS_TEXT = {
  verified: 'Confirmed. You get an email here when someone books or cancels.',
  pending: "We sent a link to this address. Booking emails start once you click it.",
  unconfirmed: 'Not confirmed yet: no booking emails are sent here until you click the link we send.',
  'not-sent': "The confirmation email couldn't be sent. Check the server's email settings, then send it again.",
};

export default function SettingsCard({ availability, onSave, emailVerification = 'none', onResendConfirmation }) {
  const [draft, setDraft] = React.useState(() => settingsOf(availability));
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState(null);

  // Show what was loaded or saved elsewhere (e.g. the weekly hours card)
  const savedSettings = React.useMemo(() => settingsOf(availability), [availability]);
  const savedKey = JSON.stringify(savedSettings);
  React.useEffect(() => { setDraft(JSON.parse(savedKey)); }, [savedKey]);

  const set = (field) => (value) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
    setSaved(false);
  };
  const changed = JSON.stringify(draft) !== savedKey;
  const emailChanged = draft.organizerEmail.trim().toLowerCase() !== savedSettings.organizerEmail.trim().toLowerCase();
  const [resend, setResend] = React.useState({ busy: false, message: null });
  const handleResend = async () => {
    setResend({ busy: true, message: null });
    try {
      await onResendConfirmation();
      setResend({ busy: false, message: 'Sent. Check your inbox.' });
    } catch (err) {
      setResend({ busy: false, message: err.message });
    }
  };
  const slugPreview = normalizeSlug(draft.bookingSlug);
  const slugChanged = slugPreview !== savedSettings.bookingSlug;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (draft.bookingSlug && !slugPreview) {
      setError('A booking link needs at least one letter or digit.');
      return;
    }
    if (slugChanged && savedSettings.bookingSlug &&
        !confirm('Change your booking link? The old link will stop working.')) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, bookingSlug: slugPreview || savedSettings.bookingSlug });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-2xl p-6 backdrop-blur-[10px] shadow-[var(--shadow-sm)] col-span-1 md:col-span-2">
      <div className="flex justify-between items-start mb-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text-primary)] m-0 mb-1">Booking Page Settings</h2>
          <p className="text-[0.8125rem] text-[var(--theme-text-muted)] m-0">What people see when they book, and where you're notified</p>
        </div>
        <div className="w-10 h-10 shrink-0 bg-[linear-gradient(135deg,rgba(var(--color-primary-rgb),0.2),rgba(var(--color-secondary-rgb),0.1))] rounded-[10px] flex items-center justify-center">
          <UserIcon />
        </div>
      </div>

      <form className="grid grid-cols-1 md:grid-cols-2 gap-4" onSubmit={handleSubmit}>
        <div>
          <label className={labelCls} htmlFor="settings-name">Your name</label>
          <input
            id="settings-name"
            className="form-input"
            type="text"
            maxLength={100}
            value={draft.organizerName}
            onChange={(e) => set('organizerName')(e.target.value)}
            placeholder="Shown on your booking page"
          />
        </div>

        <div>
          <label className={labelCls} htmlFor="settings-email">Email for booking notifications</label>
          <input
            id="settings-email"
            className="form-input"
            type="email"
            maxLength={254}
            value={draft.organizerEmail}
            onChange={(e) => set('organizerEmail')(e.target.value)}
            aria-describedby="settings-email-status"
            placeholder="you@example.com"
          />
          <p id="settings-email-status" className={hintCls} aria-live="polite">
            {!draft.organizerEmail.trim()
              ? 'Add an email to hear about bookings and cancellations.'
              : emailChanged
                ? "After you save, we'll send a link to confirm this address."
                : EMAIL_STATUS_TEXT[emailVerification] || 'You get an email here when someone books or cancels.'}
          </p>
          {!emailChanged && draft.organizerEmail.trim() && ['pending', 'unconfirmed', 'not-sent'].includes(emailVerification) && onResendConfirmation && (
            <p className={hintCls}>
              <button type="button" className="bg-transparent border-none p-0 text-[var(--color-primary-light)] underline cursor-pointer text-[0.6875rem]"
                onClick={handleResend} disabled={resend.busy}>
                {resend.busy ? 'Sending…' : 'Send the link again'}
              </button>
              {resend.message && <span className="ml-2">{resend.message}</span>}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelCls} htmlFor="settings-duration">Meeting length</label>
            <select
              id="settings-duration"
              className="form-input"
              value={draft.eventDuration}
              onChange={(e) => set('eventDuration')(Number(e.target.value))}
            >
              {[...new Set([...DURATIONS, draft.eventDuration])].sort((a, b) => a - b).map((m) => (
                <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`.replace('.5 h', ' h 30')}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="settings-timezone">Timezone</label>
            <TimezoneSearch id="settings-timezone" value={draft.timezone} onChange={set('timezone')} />
            <p className={hintCls}>
              {draft.timezone !== savedSettings.timezone
                ? 'Your weekly hours will be in this timezone. Existing meetings keep their time.'
                : 'Your weekly hours are in this timezone.'}
            </p>
          </div>
        </div>

        <div>
          <label className={labelCls} htmlFor="settings-slug">Booking link</label>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-[var(--theme-text-muted)] whitespace-nowrap">{window.location.origin}/book/</span>
            <input
              id="settings-slug"
              className="form-input"
              type="text"
              maxLength={100}
              value={draft.bookingSlug}
              onChange={(e) => set('bookingSlug')(e.target.value)}
              aria-describedby="settings-slug-hint"
            />
          </div>
          <p id="settings-slug-hint" className={hintCls}>
            {slugChanged && slugPreview
              ? `Will be saved as /book/${slugPreview}. The current link stops working.`
              : 'Lowercase letters, digits and dashes.'}
          </p>
        </div>

        {error && (
          <p role="alert" className="md:col-span-2 text-xs text-[var(--color-error)] m-0">{error}</p>
        )}

        <div className="md:col-span-2">
          <button className="btn btn-primary" type="submit" disabled={saving || !changed}>
            {saving
              ? <><LoaderIcon className="btn-loader" /> Saving...</>
              : saved ? <><CheckIcon style={{ width: 14, height: 14 }} /> Saved</> : 'Save settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
