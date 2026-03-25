import React from 'react';
import { CalendarIcon, ClockIcon, ChevronLeftIcon, ChevronRightIcon, LoaderIcon } from '../common/Icons';

export default function BookingView({
  availability, currentMonth, setCurrentMonth, selectedDate, setSelectedDate,
  selectedSlot, setSelectedSlot, slots, slotsLoading, setView,
}) {
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();
  const today = new Date();
  today.setHours(0,0,0,0);

  const isAvailableDay = (date) => {
    if (date < today) return false;
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const dayName = dayNames[date.getDay()];
    return availability?.[dayName]?.enabled || false;
  };

  const allDays = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    allDays.push({ day: prevDays - i, current: false });
  }
  for (let i = 1; i <= daysInMonth; i++) {
    const date = new Date(year, month, i);
    allDays.push({ day: i, current: true, date, available: isAvailableDay(date), isToday: date.getTime() === today.getTime() });
  }
  const remaining = 42 - allDays.length;
  for (let i = 1; i <= remaining; i++) {
    allDays.push({ day: i, current: false });
  }

  // Skip leading weeks with no available days
  let startIndex = 0;
  for (let row = 0; row < 6; row++) {
    const week = allDays.slice(row * 7, row * 7 + 7);
    if (week.some(d => d.available)) break;
    startIndex = (row + 1) * 7;
  }
  const calendarDays = allDays.slice(startIndex);

  const getDayClasses = (d) => {
    const base = 'aspect-square flex items-center justify-center rounded-[10px] text-[0.8125rem] font-medium transition-all duration-200 relative';
    if (!d.current) return `${base} text-[var(--user-text-disabled)] bg-transparent border border-transparent`;
    if (!d.available) return `${base} text-[var(--user-text-disabled)] cursor-not-allowed bg-transparent border border-transparent opacity-40`;
    const isSelected = selectedDate && d.date && selectedDate.getTime() === d.date.getTime();
    if (isSelected) {
      return `${base} bg-gradient-to-br from-user-primary to-user-dark text-white cursor-pointer border border-transparent shadow-md ${d.isToday ? 'calendar-day-today' : ''}`;
    }
    return `${base} text-[var(--user-text)] font-semibold border border-user-primary/25 bg-user-primary/[0.06] cursor-pointer hover:bg-user-primary/[0.15] hover:border-user-primary/40 ${d.isToday ? 'calendar-day-today' : ''}`;
  };

  const getSlotClasses = (slot) => {
    const base = 'px-3.5 py-2.5 rounded-lg font-display text-[0.8125rem] transition-all duration-200 text-center';
    if (slot.booked) return `${base} bg-transparent border border-[var(--user-card-border)] text-[var(--user-text-disabled)] cursor-not-allowed line-through`;
    if (selectedSlot?.time === slot.time) return `${base} bg-gradient-to-br from-user-primary to-user-dark text-white cursor-pointer border border-transparent`;
    return `${base} bg-[var(--user-card-bg)] border border-[var(--user-card-border)] text-[var(--user-text)] cursor-pointer hover:bg-[rgba(var(--user-primary-rgb),0.15)] hover:border-[rgba(var(--user-primary-rgb),0.3)]`;
  };

  return (
    <div className="bg-[var(--user-card-bg)] border border-[var(--user-card-border)] rounded-2xl p-6 backdrop-blur-[10px] col-span-full">
      <div className="flex justify-between items-start mb-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--user-text)] m-0 mb-1">Book a Meeting</h2>
          <p className="text-[0.8125rem] text-[var(--user-text-muted)] m-0">
            {availability?.eventDuration || 30} minute meeting · {availability?.timezone || 'Local time'}
          </p>
        </div>
        <div className="w-10 h-10 bg-[linear-gradient(135deg,rgba(var(--user-primary-rgb),0.2),rgba(var(--user-accent-rgb),0.1))] rounded-[10px] flex items-center justify-center">
          <CalendarIcon className="w-5 h-5 text-[var(--user-primary)]" />
        </div>
      </div>
      <div className="grid gap-8" style={{ gridTemplateColumns: selectedDate ? '1fr 280px' : '1fr' }}>
        <div>
          <div className="flex items-center gap-3.5">
            <button
              className="w-8 h-8 rounded-lg border border-[var(--user-card-border)] bg-[var(--user-card-bg)] text-[var(--user-text)] cursor-pointer flex items-center justify-center transition-all duration-200 hover:bg-[var(--user-card-bg)] hover:border-[var(--user-input-border)]"
              onClick={() => setCurrentMonth(new Date(year, month - 1, 1))}
            >
              <ChevronLeftIcon className="w-4 h-4" />
            </button>
            <span className="text-lg font-semibold text-[var(--user-text)]">
              {currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </span>
            <button
              className="w-8 h-8 rounded-lg border border-[var(--user-card-border)] bg-[var(--user-card-bg)] text-[var(--user-text)] cursor-pointer flex items-center justify-center transition-all duration-200 hover:bg-[var(--user-card-bg)] hover:border-[var(--user-input-border)]"
              onClick={() => setCurrentMonth(new Date(year, month + 1, 1))}
            >
              <ChevronRightIcon className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1.5 mt-4">
            {days.map(d => (
              <div key={d} className="text-center text-[0.6875rem] font-semibold text-[var(--user-text-muted)] uppercase tracking-[0.05em] p-2">{d}</div>
            ))}
            {calendarDays.map((d, i) => (
              <div
                key={i}
                className={getDayClasses(d)}
                onClick={() => d.available && d.date && setSelectedDate(d.date)}
              >
                {d.day}
              </div>
            ))}
          </div>
        </div>
        {selectedDate && (
          <div className="pl-6 border-l border-[var(--user-card-border)]">
            <div className="mb-4">
              <div className="text-[0.9375rem] font-semibold text-[var(--user-text)] mb-1">
                {selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
              </div>
              <div className="text-xs text-[var(--user-text-muted)]">{availability?.timezone || 'Local time'}</div>
            </div>
            {slotsLoading ? (
              <div className="flex items-center justify-center gap-3 p-8 text-[var(--user-text-muted)]">
                <LoaderIcon className="w-5 h-5 text-[var(--color-info)]" />
                <span>Loading slots...</span>
              </div>
            ) : slots.length === 0 ? (
              <div className="text-center p-8 text-[var(--user-text-muted)] text-sm">No available slots for this day</div>
            ) : (
              <div className="grid grid-cols-2 gap-2 max-h-[350px] overflow-y-auto pr-2">
                {slots.map(slot => (
                  <div
                    key={slot.time}
                    className={getSlotClasses(slot)}
                    onClick={() => !slot.booked && setSelectedSlot(slot)}
                  >
                    {slot.display}
                  </div>
                ))}
              </div>
            )}
            {selectedSlot && (
              <div className="mt-4">
                <button className="btn w-full bg-gradient-to-br from-user-primary to-user-dark text-white border-none" onClick={() => setView('form')}>
                  Continue
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <style>{`
        .calendar-day-today::after {
          content: '';
          position: absolute;
          bottom: 4px;
          width: 4px;
          height: 4px;
          background: var(--user-accent);
          border-radius: 50%;
        }
      `}</style>
    </div>
  );
}
