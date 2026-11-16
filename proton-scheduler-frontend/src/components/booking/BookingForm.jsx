import React from 'react';
import { CalendarIcon, LoaderIcon, RepeatIcon } from '../common/Icons';

// What each "Repeat" choice means as a recurrence rule
const REPEAT_OPTIONS = [
  { id: 'daily', label: 'Daily', rule: { frequency: 'DAILY' } },
  { id: 'weekly', label: 'Weekly', rule: { frequency: 'WEEKLY' } },
  { id: 'biweekly', label: 'Every 2 weeks', rule: { frequency: 'WEEKLY', interval: 2 } },
  { id: 'monthly', label: 'Monthly', rule: { frequency: 'MONTHLY' } },
];

/** The option a recurrence rule corresponds to, if any. */
function repeatOptionFor(recurrence) {
  if (!recurrence) return null;
  return REPEAT_OPTIONS.find((o) =>
    o.rule.frequency === recurrence.frequency && (o.rule.interval || 1) === (recurrence.interval || 1)) || null;
}

/**
 * @param {boolean} [allowRepeat] Offer repeating meetings. Only the organizer
 *   can book a series, from the dashboard; a visitor books one meeting.
 */
export default function BookingForm({
  selectedDate, selectedSlot, availability, bookingForm, setBookingForm,
  handleBooking, saving, setView, allowRepeat = false,
}) {
  const repeat = repeatOptionFor(bookingForm.recurrence);
  const inputCls = 'w-full py-3 px-3.5 rounded-lg text-sm leading-relaxed transition-all duration-150 bg-[var(--user-input-bg)] border-[1.5px] border-[var(--user-input-border)] text-[var(--user-text)] outline-none focus:border-[rgba(var(--user-primary-rgb),0.5)] focus:shadow-[0_0_0_3px_rgba(var(--user-primary-rgb),0.1)] placeholder:text-[var(--user-text-disabled)]';
  const labelCls = 'block text-xs font-medium mb-1.5 text-[var(--user-text-disabled)]';

  return (
    <div className="bg-[var(--user-card-bg)] border border-[var(--user-card-border)] rounded-2xl p-6 backdrop-blur-[10px] max-w-[480px] mx-auto">
      <div className="bg-[rgba(var(--user-primary-rgb),0.08)] border border-[rgba(var(--user-primary-rgb),0.2)] rounded-xl p-4 mb-5 flex items-center gap-4">
        <div className="w-11 h-11 rounded-[10px] flex items-center justify-center bg-gradient-to-br from-user-primary to-user-dark">
          <CalendarIcon className="w-[22px] h-[22px] text-white" />
        </div>
        <div>
          <h3 className="text-[0.9375rem] font-semibold text-[var(--user-text)] m-0 mb-1">{selectedDate?.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
          <p className="text-[0.8125rem] text-[var(--user-primary)] m-0">{selectedSlot?.display} · {availability?.eventDuration || 30} min</p>
        </div>
      </div>
      <div className="mb-4">
        <label className={labelCls}>Your Name *</label>
        <input
          type="text"
          className={inputCls}
          placeholder="John Doe"
          value={bookingForm.name}
          onChange={(e) => setBookingForm({ ...bookingForm, name: e.target.value })}
        />
      </div>
      <div className="mb-4">
        <label className={labelCls}>Email Address *</label>
        <input
          type="email"
          className={inputCls}
          placeholder="john@example.com"
          value={bookingForm.email}
          onChange={(e) => setBookingForm({ ...bookingForm, email: e.target.value })}
        />
      </div>
      <div className="mb-4">
        <label className={labelCls}>Notes (optional)</label>
        <textarea
          className={`${inputCls} resize-y min-h-[90px]`}
          placeholder="What would you like to discuss?"
          value={bookingForm.notes}
          onChange={(e) => setBookingForm({ ...bookingForm, notes: e.target.value })}
        />
      </div>
      {allowRepeat && (
        <div className="mb-4">
          <label className={labelCls}>Repeat</label>
          <select
            className={inputCls}
            value={repeat?.id || 'none'}
            onChange={(e) => {
              const option = REPEAT_OPTIONS.find((o) => o.id === e.target.value);
              setBookingForm({
                ...bookingForm,
                recurrence: option ? { ...option.rule, count: bookingForm.recurrence?.count || 4 } : null,
              });
            }}
          >
            <option value="none">Does not repeat</option>
            {REPEAT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
      )}
      {allowRepeat && bookingForm.recurrence && (
        <div className="mb-4">
          <label className={labelCls}>Number of occurrences</label>
          <input
            type="number"
            className={inputCls}
            min="2"
            max="52"
            value={bookingForm.recurrence.count || 4}
            onChange={(e) => setBookingForm({
              ...bookingForm,
              recurrence: { ...bookingForm.recurrence, count: Math.min(Math.max(parseInt(e.target.value, 10) || 4, 2), 52) }
            })}
          />
          <small className="flex items-center gap-1.5 text-[var(--user-primary)] text-xs mt-2">
            <RepeatIcon style={{ width: 14, height: 14 }} />
            {bookingForm.recurrence.count || 4} meetings, {(repeat?.label || '').toLowerCase()}
          </small>
        </div>
      )}
      <div className="flex gap-3.5 mt-6">
        <button className="btn bg-transparent border-[1.5px] border-[var(--user-card-border)] text-[var(--user-text)]" onClick={() => setView('booking')}>Back</button>
        <button
          className="btn flex-1 bg-gradient-to-br from-user-primary to-user-dark text-white border-none"
          onClick={handleBooking}
          disabled={saving || !bookingForm.name || !bookingForm.email}
        >
          {saving ? <><LoaderIcon className="btn-loader" /> Booking...</> : 'Confirm Booking'}
        </button>
      </div>
    </div>
  );
}
