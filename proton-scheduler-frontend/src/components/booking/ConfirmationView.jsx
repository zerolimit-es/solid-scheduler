import React from 'react';
import { CheckIcon, DownloadIcon, CalendarIcon } from '../common/Icons';

export default function ConfirmationView({ bookedEvent, setView, setBookedEvent, setSelectedDate, setSelectedSlot, setBookingForm, isPublic }) {
  const handleBookAnother = () => {
    setBookedEvent(null);
    setSelectedDate(null);
    setSelectedSlot(null);
    setBookingForm({ name: '', email: '', notes: '', recurrence: null });
    setView('booking');
  };

  return (
    <div className="bg-[var(--user-card-bg)] border border-[var(--user-card-border)] rounded-2xl p-6 backdrop-blur-[10px] max-w-[480px] mx-auto text-center">
      <div className="w-[72px] h-[72px] bg-[linear-gradient(135deg,rgba(var(--user-accent-rgb),0.2),rgba(var(--user-primary-rgb),0.1))] rounded-full flex items-center justify-center mx-auto mb-5">
        <CheckIcon className="w-9 h-9 text-[var(--user-accent)]" />
      </div>
      <h2 className="text-[1.375rem] font-bold text-[var(--user-text)] m-0 mb-1.5">Meeting Confirmed!</h2>
      <p className="text-sm text-[var(--user-text-muted)] m-0 mb-6">
        {bookedEvent.isRecurring
          ? `${bookedEvent.recurrenceCount || ''} meetings have been scheduled`
          : 'Your meeting has been scheduled'}
      </p>
      <div className="bg-[var(--user-card-bg)] border border-[var(--user-card-border)] rounded-xl p-5 mb-5 text-left">
        <div className="flex justify-between py-2.5 border-b border-[var(--user-border)]">
          <span className="text-[0.8125rem] text-[var(--user-text-muted)]">Date</span>
          <span className="text-[0.8125rem] text-[var(--user-text)] font-medium">{bookedEvent.date}</span>
        </div>
        <div className="flex justify-between py-2.5 border-b border-[var(--user-border)]">
          <span className="text-[0.8125rem] text-[var(--user-text-muted)]">Time</span>
          <span className="text-[0.8125rem] text-[var(--user-text)] font-medium">{bookedEvent.time || bookedEvent.startTime}</span>
        </div>
        <div className={`flex justify-between py-2.5 ${bookedEvent.attendee || bookedEvent.assignedMember || bookedEvent.location || bookedEvent.notes ? 'border-b border-[var(--user-border)]' : ''}`}>
          <span className="text-[0.8125rem] text-[var(--user-text-muted)]">Duration</span>
          <span className="text-[0.8125rem] text-[var(--user-text)] font-medium">{bookedEvent.duration || 30} min</span>
        </div>
        {bookedEvent.attendee && (
          <div className={`flex justify-between py-2.5 ${bookedEvent.assignedMember || bookedEvent.location || bookedEvent.notes ? 'border-b border-[var(--user-border)]' : ''}`}>
            <span className="text-[0.8125rem] text-[var(--user-text-muted)]">With</span>
            <span className="text-[0.8125rem] text-[var(--user-text)] font-medium">
              {typeof bookedEvent.attendee === 'object' ? bookedEvent.attendee.name : bookedEvent.attendee}
            </span>
          </div>
        )}
        {bookedEvent.assignedMember && (
          <div className={`flex justify-between py-2.5 ${bookedEvent.location || bookedEvent.notes ? 'border-b border-[var(--user-border)]' : ''}`}>
            <span className="text-[0.8125rem] text-[var(--user-text-muted)]">Assigned To</span>
            <span className="text-[0.8125rem] text-[var(--user-text)] font-medium">{bookedEvent.assignedMember.name}</span>
          </div>
        )}
        {bookedEvent.location && (
          <div className={`flex justify-between py-2.5 ${bookedEvent.notes ? 'border-b border-[var(--user-border)]' : ''}`}>
            <span className="text-[0.8125rem] text-[var(--user-text-muted)]">Where</span>
            <span className="text-[0.8125rem] text-[var(--user-text)] font-medium">{bookedEvent.location}</span>
          </div>
        )}
        {bookedEvent.notes && (
          <div className="flex justify-between py-2.5">
            <span className="text-[0.8125rem] text-[var(--user-text-muted)]">Notes</span>
            <span className="text-[0.8125rem] text-[var(--user-text)] font-medium">{bookedEvent.notes}</span>
          </div>
        )}
      </div>
      {bookedEvent.icsUrl && (
        <a
          className="flex items-center justify-center gap-2 w-full py-3.5 bg-[rgba(var(--user-accent-rgb),0.1)] border border-[rgba(var(--user-accent-rgb),0.3)] rounded-lg text-[var(--user-accent)] text-sm font-medium no-underline cursor-pointer transition-all duration-200 mb-3.5"
          href={bookedEvent.icsUrl}
        >
          <DownloadIcon /> Download .ics
        </a>
      )}
      <div className="flex gap-3 justify-center">
        <button className="btn bg-transparent border-[1.5px] border-[var(--user-card-border)] text-[var(--user-text)]" onClick={handleBookAnother}>Book Another</button>
        {!isPublic && <button className="btn btn-primary" onClick={() => setView('dashboard')}>Dashboard</button>}
      </div>
      <div className="inline-flex items-center gap-1.5 text-xs text-[var(--user-text-muted)] mt-4">
        Secured by Solid Pod
      </div>
    </div>
  );
}
