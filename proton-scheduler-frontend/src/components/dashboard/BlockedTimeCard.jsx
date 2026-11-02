import React from 'react';
import { Ban } from 'lucide-react';
import { api } from '../../services/api';
import { LoaderIcon } from '../common/Icons';

const UPCOMING_DAYS = 90;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function plusDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" → "Tue 10 Sep", without shifting through the browser's timezone. */
function formatDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

function describeRecurrence(rrule) {
  if (!rrule) return null;
  const freq = /FREQ=(\w+)/.exec(rrule)?.[1];
  const byDay = /BYDAY=([\w,]+)/.exec(rrule)?.[1];
  if (freq === 'DAILY') return 'Every day';
  if (freq === 'WEEKLY' && byDay === 'MO,TU,WE,TH,FR') return 'Every weekday';
  if (freq === 'WEEKLY') return 'Every week';
  if (freq === 'MONTHLY') return 'Every month';
  if (freq === 'YEARLY') return 'Every year';
  return 'Repeats';
}

function describeWhen(ev) {
  const [startDate, startTime] = ev.start.split(' ');
  const [endDate, endTime] = ev.end.split(' ');
  if (ev.allDay) {
    const lastDay = plusDays(endDate, -1);
    return lastDay > startDate ? `${formatDay(startDate)} – ${formatDay(lastDay)}, all day` : `${formatDay(startDate)}, all day`;
  }
  return endDate === startDate
    ? `${formatDay(startDate)}, ${startTime}–${endTime}`
    : `${formatDay(startDate)} ${startTime} – ${formatDay(endDate)} ${endTime}`;
}

function describeImport(result) {
  const s = result.skipped || {};
  const parts = [
    s.past && `${s.past} past`,
    s.duplicate && `${s.duplicate} already imported`,
    s.cancelled && `${s.cancelled} cancelled`,
    s.free && `${s.free} marked free`,
    s.invalid && `${s.invalid} unreadable`,
  ].filter(Boolean);
  const head = `Imported ${result.imported} event${result.imported === 1 ? '' : 's'}.`;
  return parts.length ? `${head} Skipped ${parts.join(', ')}.` : head;
}

const inputClass = 'min-w-0 bg-[var(--theme-booking-link-bg)] border border-[var(--theme-card-border)] rounded-md px-3 py-2 text-sm text-[var(--color-text-primary)]';

/**
 * Blocked time: calendar events that make the organizer unavailable. Each one
 * hides the booking slots it overlaps.
 */
export default function BlockedTimeCard() {
  const [events, setEvents] = React.useState([]);
  const [timezone, setTimezone] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState(null);
  const fileInput = React.useRef(null);

  const [form, setForm] = React.useState(() => ({
    title: '', date: todayISO(), allDay: false, start: '09:00', end: '10:00', repeat: 'none',
  }));
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const load = React.useCallback(async () => {
    try {
      const from = todayISO();
      const data = await api.calendar.getEvents(from, plusDays(from, UPCOMING_DAYS));
      setEvents(data.events || []);
      setTimezone(data.timezone || null);
    } catch (err) {
      setError(`Could not load blocked time: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const handleAdd = async (e) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const weekday = WEEKDAYS[new Date(`${form.date}T12:00:00Z`).getUTCDay()];
    const recurrence = {
      none: null,
      daily: 'FREQ=DAILY',
      weekly: `FREQ=WEEKLY;BYDAY=${weekday}`,
      weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    }[form.repeat];
    const body = form.allDay
      ? { title: form.title, allDay: true, start: form.date, end: form.date, recurrence }
      : { title: form.title, start: `${form.date} ${form.start}`, end: `${form.date} ${form.end}`, recurrence };
    setBusy(true);
    try {
      await api.calendar.createEvent(body);
      setForm((f) => ({ ...f, title: '' }));
      setNotice('Time blocked. Visitors can no longer book it.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (ev) => {
    if (!confirm(`Remove "${ev.title}"? That time becomes bookable again.`)) return;
    setDeletingId(ev.id);
    setError(null);
    setNotice(null);
    try {
      await api.calendar.deleteEvent(ev.id);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await api.calendar.importIcs(await file.text());
      setNotice(describeImport(result));
      await load();
    } catch (err) {
      setError(`Import failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-2xl p-6 backdrop-blur-[10px] shadow-[var(--shadow-sm)] col-span-1 md:col-span-2">
      <div className="flex justify-between items-start mb-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text-primary)] m-0 mb-1">Blocked Time</h2>
          <p className="text-[0.8125rem] text-[var(--theme-text-muted)] m-0">
            Visitors can't book time you block here. Times are in your availability timezone{timezone ? ` (${timezone})` : ''}.
          </p>
        </div>
        <div className="w-10 h-10 shrink-0 bg-[linear-gradient(135deg,rgba(var(--color-primary-rgb),0.2),rgba(var(--color-secondary-rgb),0.1))] rounded-[10px] flex items-center justify-center">
          <Ban size={20} strokeWidth={1.75} />
        </div>
      </div>

      {error && <div role="alert" className="text-red-500 bg-red-500/10 p-3 rounded-lg mb-4 text-[13px]">{error}</div>}
      {notice && <div role="status" className="text-status-success bg-[rgba(var(--color-secondary-rgb),0.1)] p-3 rounded-lg mb-4 text-[13px]">{notice}</div>}

      {loading ? (
        <p className="text-xs text-[var(--theme-text-muted)] animate-pulse m-0 mb-4">Loading blocked time…</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-[var(--theme-text-muted)] m-0 mb-4">Nothing blocked in the next {UPCOMING_DAYS} days.</p>
      ) : (
        <ul className="list-none p-0 m-0 mb-4 flex flex-col gap-2 max-h-72 overflow-y-auto" aria-label="Blocked time">
          {events.map((ev) => (
            <li key={ev.id} className="flex items-center gap-3 bg-[var(--theme-booking-link-bg)] border border-[var(--theme-card-border)] rounded-[10px] px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--color-text-primary)] overflow-hidden text-ellipsis whitespace-nowrap">{ev.title}</div>
                <div className="text-[0.6875rem] text-[var(--theme-text-muted)]">
                  {describeWhen(ev)}
                  {ev.recurrence ? ` · ${describeRecurrence(ev.recurrence)}` : ''}
                  {ev.imported ? ' · imported' : ''}
                </div>
              </div>
              <button
                className="py-1.5 px-3 bg-transparent border border-[var(--theme-card-border)] rounded-md text-xs text-[var(--theme-text-muted)] cursor-pointer hover:text-red-500 hover:border-red-500/50 transition-all duration-200 disabled:opacity-60 disabled:cursor-wait"
                onClick={() => handleDelete(ev)}
                disabled={deletingId === ev.id}
                aria-label={`Remove ${ev.title}`}
              >
                {deletingId === ev.id ? 'Removing…' : 'Remove'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex flex-col gap-3" aria-label="Block time">
        <div className="flex flex-col sm:flex-row gap-3">
          <input className={`${inputClass} flex-1`} value={form.title} onChange={set('title')} placeholder="What is it? e.g. Dentist" maxLength={200} required aria-label="Title" />
          <input className={inputClass} type="date" value={form.date} onChange={set('date')} required aria-label="Date" />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
            <input type="checkbox" checked={form.allDay} onChange={set('allDay')} /> All day
          </label>
          {!form.allDay && (
            <>
              <input className={inputClass} type="time" value={form.start} onChange={set('start')} required aria-label="Start time" />
              <span className="text-[var(--theme-text-muted)]">to</span>
              <input className={inputClass} type="time" value={form.end} onChange={set('end')} required aria-label="End time" />
            </>
          )}
          <select className={inputClass} value={form.repeat} onChange={set('repeat')} aria-label="Repeat">
            <option value="none">Doesn't repeat</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="weekdays">Every weekday</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={busy}
            className="py-2 px-4 bg-brand-primary hover:bg-brand-primary/90 border-none rounded-md text-white text-sm font-medium cursor-pointer flex items-center gap-2 transition-all duration-200 disabled:opacity-60 disabled:cursor-wait"
          >
            {busy ? <><LoaderIcon style={{ width: 14, height: 14 }} /> Saving…</> : 'Block time'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
            className="py-2 px-4 bg-transparent border border-[var(--theme-card-border)] rounded-md text-sm text-[var(--color-text-primary)] cursor-pointer disabled:opacity-60 disabled:cursor-wait"
          >
            Import .ics file
          </button>
          <input ref={fileInput} type="file" accept=".ics,text/calendar" className="hidden" onChange={handleImport} aria-label="Calendar file to import" />
        </div>
      </form>
    </div>
  );
}
