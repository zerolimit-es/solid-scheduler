/**
 * Bookable slots.
 *
 * One set of rules for the public slot list, the public booking endpoint and
 * the organizer's own "Book" view, so a time can be booked exactly when a
 * page offers it.
 */

import { getAvailability, getBookedSlots } from '../cloud/models/bookings-db.js';
import { getBlockedIntervals, isBlocked } from '../cloud/models/calendar-events-db.js';
import { isValidTimeZone, instantToNaive, parseNaive } from '../utils/tz.js';

export const DEFAULT_TIMEZONE = 'Europe/Paris';
export const DEFAULT_DURATION = 30;
const MIN_NOTICE_MINUTES = 15;
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** "HH:MM" → minutes since midnight, or null if it isn't a time of day. */
export function toMinutes(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof value === 'string' ? value : '');
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && total <= 24 * 60 ? total : null;
}

export function toTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function toDisplayTime(minutes) {
  const hour = Math.floor(minutes / 60) % 24;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minutes % 60).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
}

/** True for "YYYY-MM-DD" naming a real calendar day. */
export function isRealDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !!parseNaive(`${date} 00:00`);
}

/** The booking page's meeting length and timezone, with safe fallbacks. */
export function pageSettings(slug) {
  const avail = getAvailability(slug);
  const d = Number(avail?.eventDuration);
  return {
    avail,
    duration: Number.isInteger(d) && d >= 5 && d <= 480 ? d : DEFAULT_DURATION,
    tz: isValidTimeZone(avail?.timezone) ? avail.timezone : DEFAULT_TIMEZONE,
  };
}

/** What a page offers until its owner saves their hours: weekdays, 09:00–17:00. */
const DEFAULT_DAY = { start: '09:00', end: '17:00' };
const DEFAULT_WEEK = Object.fromEntries(DAY_NAMES.map((name) => [
  name, { enabled: name !== 'saturday' && name !== 'sunday', ...DEFAULT_DAY },
]));

/**
 * The page's settings for one weekday, as the public availability endpoint
 * reports them: the saved day, switched off if saved hours leave it out, or
 * the default week when nothing has been saved.
 */
export function daySettings(avail, dayName) {
  if (!avail) return DEFAULT_WEEK[dayName];
  const saved = avail.days?.[dayName] || avail[dayName];
  return {
    enabled: !!saved?.enabled,
    start: saved?.start || DEFAULT_DAY.start,
    end: saved?.end || DEFAULT_DAY.end,
  };
}

/** Working hours for `date` in minutes, or null when the day is switched off. */
export function dayWindow(avail, date) {
  const [y, m, d] = date.split('-').map(Number);
  const settings = daySettings(avail, DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]);
  if (!settings.enabled) return null;
  const start = toMinutes(settings.start) ?? 9 * 60;
  // A booking must end the same day (bookings are stored per day)
  const end = Math.min(toMinutes(settings.end) ?? 17 * 60, 24 * 60 - 1);
  return end > start ? { start, end } : null;
}

/**
 * Start times (minutes since midnight) offered on `date`: every `duration`
 * minutes within working hours. Nothing on past days; today only from
 * MIN_NOTICE_MINUTES ahead.
 */
export function slotStarts(date, { avail, duration, tz }) {
  const now = instantToNaive(new Date(), tz);
  const today = now.slice(0, 10);
  if (date < today) return [];
  const earliest = date === today ? toMinutes(now.slice(11)) + MIN_NOTICE_MINUTES : -1;

  const starts = [];
  const hours = dayWindow(avail, date);
  if (hours) {
    for (let m = hours.start; m + duration <= hours.end; m += duration) starts.push(m);
  }
  return starts.filter((m) => m !== null && m > earliest);
}

/** Existing bookings on `date` as minute ranges. */
export function bookedIntervals(slug, date) {
  return getBookedSlots(slug, date).map((b) => {
    const startMin = toMinutes(String(b.start_time).slice(11));
    if (startMin === null) return null;
    const sameDay = String(b.end_time).slice(0, 10) === date;
    const endMin = sameDay ? toMinutes(String(b.end_time).slice(11)) : 24 * 60;
    return { startMin, endMin: endMin !== null && endMin > startMin ? endMin : startMin + DEFAULT_DURATION };
  }).filter(Boolean);
}

/**
 * The slots offered on `date` for a booking page, each marked booked when
 * a booking or blocked time overlaps it.
 *
 * @param {string} slug
 * @param {string} date - "YYYY-MM-DD", already checked with isRealDate()
 * @param {number|null} organizerId - The tenant id, for blocked time
 */
export function slotsFor(slug, date, organizerId) {
  const settings = pageSettings(slug);
  const { duration } = settings;
  const booked = bookedIntervals(slug, date);
  const calBlocked = organizerId ? getBlockedIntervals(organizerId, date) : [];
  const slots = slotStarts(date, settings).map((m) => ({
    time: toTime(m),
    displayTime: toDisplayTime(m),
    isBooked: isBlocked(booked, m, m + duration) || isBlocked(calBlocked, m, m + duration),
  }));
  return { date, duration, slots, count: slots.filter((s) => !s.isBooked).length };
}
