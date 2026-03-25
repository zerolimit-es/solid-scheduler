import React from 'react';
import { CalendarIcon, ClockIcon, LinkIcon, CheckIcon, LoaderIcon, DownloadIcon, CancelIcon } from '../common/Icons';
import { AlertTriangle, Check } from 'lucide-react';

export default function DashboardView({
  user, availability, bookings, setBookings, stats, podStatus, setPodStatus,
  linkCopied, setLinkCopied, saving, setSaving, saved, setSaved,
  handleSaveAvailability, setAvailability, setError,
}) {
  const slug = user?.bookingSlug || availability?.bookingSlug || null;
  const [cancellingId, setCancellingId] = React.useState(null);

  const handleCancel = async (bookingId) => {
    if (!confirm('Cancel this meeting? The attendee will be notified by email.')) return;
    setCancellingId(bookingId);
    const booking = bookings.find(b => b.id === bookingId);
    try {
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(booking ? {
          title: booking.title, start: booking.start, end: booking.end,
          attendee: booking.attendee, notes: booking.notes, location: booking.location,
        } : undefined),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to cancel booking');
      }
      setBookings(prev => prev.filter(b => b.id !== bookingId));
    } catch (err) {
      console.error('[Cancel] Failed:', err.message);
      setError(err.message);
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <>
      {/* Subtle Pod indicator — Pod sync is invisible infrastructure */}
      <div className="flex items-center gap-2 mb-4 px-1">
        <div
          className={
            "w-1.5 h-1.5 rounded-full shrink-0 " +
            (podStatus.connected
              ? "bg-[var(--color-secondary)] shadow-[0_0_4px_rgba(var(--color-secondary-rgb),0.4)]"
              : "bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.4)]")
          }
          title={podStatus.connected
            ? "Data backed up to your Solid Pod"
            : "Pod offline — data safe locally, will sync when reconnected"}
        />
        <span className="text-[11px] text-[var(--theme-text-muted)]">
          {podStatus.connected ? "Pod synced" : "Pod offline"}
        </span>
      </div>

      {/* Dashboard Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Booking Link Card */}
        <div className="bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-2xl p-6 backdrop-blur-[10px] shadow-[var(--shadow-sm)]">
          <div className="flex justify-between items-start mb-5">
            <div>
              <h2 className="text-base font-semibold text-[var(--color-text-primary)] m-0 mb-1">Your Booking Link</h2>
              <p className="text-[0.8125rem] text-[var(--theme-text-muted)] m-0">Share this link to let others schedule time with you</p>
            </div>
            <div className="w-10 h-10 bg-[linear-gradient(135deg,rgba(var(--color-primary-rgb),0.2),rgba(var(--color-secondary-rgb),0.1))] rounded-[10px] flex items-center justify-center">
              <LinkIcon />
            </div>
          </div>
          <div className="flex items-center gap-3 bg-[var(--theme-booking-link-bg)] border border-[var(--theme-card-border)] rounded-[10px] px-4 py-3 mb-4">
            {slug ? (
              <>
                <span className="flex-1 font-display text-xs text-[var(--color-primary)] overflow-hidden text-ellipsis whitespace-nowrap">
                  {window.location.origin}/book/{slug}
                </span>
                <button
                  className="py-1.5 px-3.5 bg-brand-primary hover:bg-brand-primary/90 border-none rounded-md text-white text-xs font-medium cursor-pointer flex items-center gap-1 transition-all duration-200"
                  onClick={() => {
                    navigator.clipboard.writeText(`${window.location.origin}/book/${slug}`);
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 2000);
                  }}
                >
                  {linkCopied ? <><CheckIcon style={{ width: 14, height: 14 }} /> Copied!</> : 'Copy'}
                </button>
              </>
            ) : (
              <span className="flex-1 font-display text-xs text-[var(--theme-text-muted)] animate-pulse">Loading booking link…</span>
            )}
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div className="text-center p-3.5 bg-[var(--theme-card-bg)] rounded-[10px] border border-[var(--theme-card-border)]">
              <div className="font-display text-xl font-bold text-[var(--color-text-primary)] mb-0.5">{stats.thisWeek || 0}</div>
              <div className="text-[0.6875rem] text-[var(--theme-text-muted)] uppercase tracking-[0.05em]">This Week</div>
            </div>
            <div className="text-center p-3.5 bg-[var(--theme-card-bg)] rounded-[10px] border border-[var(--theme-card-border)]">
              <div className="font-display text-xl font-bold text-[var(--color-text-primary)] mb-0.5">{stats.thisMonth || 0}</div>
              <div className="text-[0.6875rem] text-[var(--theme-text-muted)] uppercase tracking-[0.05em]">This Month</div>
            </div>
            <div className="text-center p-3.5 bg-[var(--theme-card-bg)] rounded-[10px] border border-[var(--theme-card-border)]">
              <div className="font-display text-xl font-bold text-[var(--color-text-primary)] mb-0.5">{stats.upcoming || 0}</div>
              <div className="text-[0.6875rem] text-[var(--theme-text-muted)] uppercase tracking-[0.05em]">Upcoming</div>
            </div>
            <div className="text-center p-3.5 bg-[var(--theme-card-bg)] rounded-[10px] border border-[var(--theme-card-border)]">
              <div className={`font-display text-xl font-bold mb-0.5 ${(stats.unsynced || 0) > 0 ? 'text-status-warning' : 'text-status-success'}`}>
                {(stats.unsynced || 0) > 0 ? <AlertTriangle size={14} strokeWidth={2} /> : <Check size={18} strokeWidth={2} />}
              </div>
              <div className="text-[0.6875rem] text-[var(--theme-text-muted)] uppercase tracking-[0.05em]">{(stats.unsynced || 0) > 0 ? stats.unsynced + ' Unsynced' : 'Pod Synced'}</div>
            </div>
          </div>
        </div>

        {/* Availability Card */}
        <div className="bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-2xl p-6 backdrop-blur-[10px] shadow-[var(--shadow-sm)]">
          <div className="flex justify-between items-start mb-5">
            <div>
              <h2 className="text-base font-semibold text-[var(--color-text-primary)] m-0 mb-1">Weekly Availability</h2>
              <p className="text-[0.8125rem] text-[var(--theme-text-muted)] m-0">Set your available hours for each day</p>
            </div>
            <div className="w-10 h-10 bg-[linear-gradient(135deg,rgba(var(--color-primary-rgb),0.2),rgba(var(--color-secondary-rgb),0.1))] rounded-[10px] flex items-center justify-center">
              <ClockIcon />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {availability && ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(day => {
              const d = availability[day] || { enabled: false, start: '09:00', end: '17:00' };
              const timeOptions = [];
              for (let h = 0; h < 24; h++) {
                for (let m = 0; m < 60; m += 30) {
                  const val = String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
                  const label = new Date(2024,0,1,h,m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                  timeOptions.push({ val, label });
                }
              }
              return (
                <div key={day} className="flex items-center gap-3.5 py-2.5 px-3.5 bg-[var(--theme-card-bg)] rounded-lg border border-[var(--theme-card-border)]">
                  <div
                    className={"day-toggle " + (d.enabled ? "active" : "")}
                    onClick={() => setAvailability({
                      ...availability,
                      [day]: { ...d, enabled: !d.enabled }
                    })}
                  />
                  <span className="w-[90px] min-w-[40px] text-[0.8125rem] font-medium text-[var(--theme-text-body)]">{day.charAt(0).toUpperCase() + day.slice(1, 3)}</span>
                  {d.enabled ? (
                    <div className="flex items-center gap-2 ml-auto">
                      <select
                        className="time-select"
                        value={d.start || '09:00'}
                        onChange={(e) => setAvailability({
                          ...availability,
                          [day]: { ...d, start: e.target.value }
                        })}
                      >
                        {timeOptions.map(t => (
                          <option key={t.val} value={t.val}>{t.label}</option>
                        ))}
                      </select>
                      <span className="text-white/30 text-[0.85rem]">→</span>
                      <select
                        className="time-select"
                        value={d.end || '17:00'}
                        onChange={(e) => setAvailability({
                          ...availability,
                          [day]: { ...d, end: e.target.value }
                        })}
                      >
                        {timeOptions.map(t => (
                          <option key={t.val} value={t.val}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <span className="font-display text-xs text-[var(--theme-text-muted)] opacity-40">Unavailable</span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-6">
            <button className="btn btn-primary" onClick={handleSaveAvailability} disabled={saving}>
              {saving ? <><LoaderIcon className="btn-loader" /> Saving...</> : saved ? '✓ Saved to Pod!' : 'Save to Pod'}
            </button>
          </div>
        </div>

        {/* Upcoming Meetings */}
        <div className="bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-2xl p-6 backdrop-blur-[10px] shadow-[var(--shadow-sm)] col-span-1 md:col-span-2">
          <div className="flex justify-between items-start mb-5">
            <div>
              <h2 className="text-base font-semibold text-[var(--color-text-primary)] m-0 mb-1">Upcoming Meetings</h2>
              <p className="text-[0.8125rem] text-[var(--theme-text-muted)] m-0">Your next scheduled meetings</p>
            </div>
            <div className="w-10 h-10 bg-[linear-gradient(135deg,rgba(var(--color-primary-rgb),0.2),rgba(var(--color-secondary-rgb),0.1))] rounded-[10px] flex items-center justify-center">
              <CalendarIcon />
            </div>
          </div>
          {bookings.length === 0 ? (
            <div className="text-center p-10 text-[var(--theme-text-muted)]">
              <CalendarIcon style={{ width: 48, height: 48, opacity: 0.2 }} />
              <p>No upcoming meetings</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {bookings.slice(0, 5).map(booking => {
                const startDate = (() => {
                  if (!booking.start) return null;
                  if (typeof booking.start === 'string' && booking.start.includes('T')) return new Date(booking.start);
                  if (typeof booking.start === 'string') {
                    const [datePart, timePart] = booking.start.split(' ');
                    if (datePart && timePart) {
                      const [y, m, d] = datePart.split('-').map(Number);
                      const [h, min] = timePart.split(':').map(Number);
                      return new Date(y, m - 1, d, h, min);
                    }
                    return new Date(booking.start.replace(' ', 'T'));
                  }
                  return new Date(booking.start);
                })();
                const attendeeName = typeof booking.attendee === 'object'
                  ? (booking.attendee?.name || booking.attendee?.email || '')
                  : (booking.attendee || '');
                return (
                <div key={booking.id} className="flex items-center gap-4 p-3.5 bg-[var(--theme-card-bg)] rounded-[10px] border border-[var(--theme-card-border)]">
                  <div className="flex flex-col items-center py-2 px-3 bg-[linear-gradient(135deg,rgba(var(--color-primary-rgb),0.15),rgba(var(--color-secondary-rgb),0.1))] rounded-lg min-w-[50px]">
                    <span className="text-[0.6875rem] text-[var(--color-primary-light)] uppercase">
                      {startDate ? startDate.toLocaleDateString('en-US', { weekday: 'short' }) : ''}
                    </span>
                    <span className="font-display text-lg font-bold text-[var(--color-text-primary)]">
                      {startDate ? startDate.getDate() : ''}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-semibold text-[var(--color-text-primary)] m-0 mb-1 overflow-hidden text-ellipsis whitespace-nowrap">{booking.title || 'Meeting'}</h4>
                    <p className="text-xs text-[var(--theme-text-muted)] m-0">
                      {startDate ? startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : ''}
                      {attendeeName ? ' · ' + attendeeName : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <a className="p-2 text-[var(--theme-text-muted)] transition-colors duration-200" href={"/api/public/" + slug + "/ics/" + booking.id} title="Download .ics">
                      <DownloadIcon style={{ width: 18, height: 18 }} />
                    </a>
                    <button
                        className="flex items-center justify-center w-9 h-9 p-0 border-none rounded-lg bg-transparent text-[var(--theme-text-muted)] cursor-pointer transition-colors duration-200 hover:text-red-500 hover:bg-red-500/10"
                        title="Cancel meeting"
                        disabled={cancellingId === booking.id}
                        onClick={() => handleCancel(booking.id)}
                      >
                        {cancellingId === booking.id
                          ? <LoaderIcon style={{ width: 18, height: 18 }} />
                          : <CancelIcon style={{ width: 18, height: 18 }} />}
                      </button>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <style>{`
        .day-toggle {
          width: 36px;
          height: 20px;
          background: rgba(255,255,255,0.1);
          border-radius: 10px;
          position: relative;
          cursor: pointer;
          transition: all 0.2s;
          flex-shrink: 0;
        }
        .day-toggle.active {
          background: #6366F1;
        }
        .day-toggle::after {
          content: '';
          position: absolute;
          top: 2px;
          left: 2px;
          width: 16px;
          height: 16px;
          background: white;
          border-radius: 50%;
          transition: all 0.2s;
        }
        .day-toggle.active::after {
          left: 18px;
        }
      `}</style>
    </>
  );
}
