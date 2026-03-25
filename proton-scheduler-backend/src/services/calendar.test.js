import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateAvailableSlots } from './calendar.js';
import { SCHEMA } from '../utils/rdf.js';

// July 1, 2030 = Monday (far future to avoid minNotice filtering)
const MON = new Date(2030, 6, 1);
const TUE = new Date(2030, 6, 2);

function makeAvailability(overrides = {}) {
  return {
    eventDuration: 30,
    bufferBefore: 0,
    bufferAfter: 0,
    minNotice: 0,
    timezone: 'UTC',
    days: {
      sunday: { enabled: false },
      monday: { enabled: true, start: '09:00', end: '12:00' },
      tuesday: { enabled: true, start: '09:00', end: '12:00' },
      wednesday: { enabled: false },
      thursday: { enabled: true, start: '09:00', end: '12:00' },
      friday: { enabled: true, start: '09:00', end: '12:00' },
      saturday: { enabled: false },
    },
    ...overrides,
  };
}

function slotsForDay(availability, date, bookings = []) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return generateAvailableSlots(availability, bookings, { startDate: start, endDate: end });
}

// ─── generateAvailableSlots ──────────────────────────────────────────

describe('generateAvailableSlots', () => {
  it('generates correct number of slots for an enabled day', () => {
    // Monday 09:00-12:00 with 30min slots = 6 slots
    const slots = slotsForDay(makeAvailability(), MON);
    assert.equal(slots.length, 6);
  });

  it('returns no slots for a disabled day', () => {
    // Wednesday is disabled
    const wed = new Date(2030, 6, 3);
    const slots = slotsForDay(makeAvailability(), wed);
    assert.equal(slots.length, 0);
  });

  it('returns no slots when all days are disabled', () => {
    const avail = makeAvailability({
      days: {
        sunday: { enabled: false }, monday: { enabled: false },
        tuesday: { enabled: false }, wednesday: { enabled: false },
        thursday: { enabled: false }, friday: { enabled: false },
        saturday: { enabled: false },
      },
    });
    const slots = slotsForDay(avail, MON);
    assert.equal(slots.length, 0);
  });

  it('respects event duration', () => {
    // 09:00-12:00 with 60min slots = 3 slots
    const avail = makeAvailability({ eventDuration: 60 });
    const slots = slotsForDay(avail, MON);
    assert.equal(slots.length, 3);
    assert.equal(slots[0].time, '09:00');
    assert.equal(slots[1].time, '10:00');
    assert.equal(slots[2].time, '11:00');
  });

  it('does not generate a slot that would exceed the end time', () => {
    // 09:00-09:45 with 30min slots = 1 slot (09:00); 09:30+30 = 10:00 > 09:45
    const avail = makeAvailability({
      days: {
        sunday: { enabled: false }, monday: { enabled: true, start: '09:00', end: '09:45' },
        tuesday: { enabled: false }, wednesday: { enabled: false },
        thursday: { enabled: false }, friday: { enabled: false },
        saturday: { enabled: false },
      },
    });
    const slots = slotsForDay(avail, MON);
    assert.equal(slots.length, 1);
    assert.equal(slots[0].time, '09:00');
  });

  it('slot objects have correct properties', () => {
    const slots = slotsForDay(makeAvailability(), MON);
    const first = slots[0];
    assert.ok(first.start instanceof Date);
    assert.ok(first.end instanceof Date);
    assert.equal(typeof first.date, 'string');
    assert.match(first.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof first.time, 'string');
    assert.match(first.time, /^\d{2}:\d{2}$/);
    assert.equal(typeof first.displayTime, 'string');
    // Duration should be 30 minutes
    assert.equal(first.end - first.start, 30 * 60 * 1000);
  });

  it('detects conflicts with existing bookings', () => {
    // Book the 10:00-10:30 slot
    const bookings = [{
      start: new Date(2030, 6, 1, 10, 0, 0),
      end: new Date(2030, 6, 1, 10, 30, 0),
      status: 'confirmed',
    }];
    const slots = slotsForDay(makeAvailability(), MON, bookings);
    // Without booking: 6 slots. With one conflict: 5 slots
    assert.equal(slots.length, 5);
    const times = slots.map(s => s.time);
    assert.ok(!times.includes('10:00'));
  });

  it('applies bufferAfter to extend booking conflict zone', () => {
    // Booking 10:00-10:30 with 15min buffer after → blocked until 10:45
    // So 10:30 slot also conflicts (10:30 < 10:45)
    const avail = makeAvailability({ bufferAfter: 15 });
    const bookings = [{
      start: new Date(2030, 6, 1, 10, 0, 0),
      end: new Date(2030, 6, 1, 10, 30, 0),
      status: 'confirmed',
    }];
    const slots = slotsForDay(avail, MON, bookings);
    const times = slots.map(s => s.time);
    assert.ok(!times.includes('10:00'), 'booked slot should be gone');
    assert.ok(!times.includes('10:30'), 'buffer slot should be gone');
    assert.ok(times.includes('11:00'), 'slot after buffer should remain');
  });

  it('applies bufferBefore to extend booking conflict zone', () => {
    // Booking 10:00-10:30 with 15min buffer before → blocked from 09:45
    // So 09:30 slot conflicts (09:30+30=10:00 > 09:45)
    const avail = makeAvailability({ bufferBefore: 15 });
    const bookings = [{
      start: new Date(2030, 6, 1, 10, 0, 0),
      end: new Date(2030, 6, 1, 10, 30, 0),
      status: 'confirmed',
    }];
    const slots = slotsForDay(avail, MON, bookings);
    const times = slots.map(s => s.time);
    assert.ok(!times.includes('09:30'), 'slot overlapping buffer should be gone');
    assert.ok(!times.includes('10:00'), 'booked slot should be gone');
    assert.ok(times.includes('09:00'), 'slot before buffer should remain');
  });

  it('skips cancelled bookings', () => {
    const bookings = [{
      start: new Date(2030, 6, 1, 10, 0, 0),
      end: new Date(2030, 6, 1, 10, 30, 0),
      status: SCHEMA.EventCancelled,
    }];
    const slots = slotsForDay(makeAvailability(), MON, bookings);
    // Cancelled booking should not reduce slots
    assert.equal(slots.length, 6);
  });

  it('handles recurring bookings by expanding them', () => {
    // A recurring weekly booking on Monday 10:00-10:30
    const bookings = [{
      start: new Date(2030, 6, 1, 10, 0, 0),
      end: new Date(2030, 6, 1, 10, 30, 0),
      status: 'confirmed',
      isRecurring: true,
      recurrence: { frequency: 'WEEKLY', count: 4 },
    }];
    const slots = slotsForDay(makeAvailability(), MON, bookings);
    // Should detect the conflict from the expanded first occurrence
    assert.equal(slots.length, 5);
    const times = slots.map(s => s.time);
    assert.ok(!times.includes('10:00'));
  });

  it('generates slots across multiple days', () => {
    const start = new Date(2030, 6, 1, 0, 0, 0); // Monday
    const end = new Date(2030, 6, 2, 23, 59, 59); // Tuesday
    const slots = generateAvailableSlots(makeAvailability(), [], {
      startDate: start,
      endDate: end,
    });
    // Monday: 6 slots, Tuesday: 6 slots
    assert.equal(slots.length, 12);
    const dates = [...new Set(slots.map(s => s.date))];
    assert.equal(dates.length, 2);
  });

  it('filters all slots when minNotice is very large', () => {
    // minNotice = 200000 hours → minBookingTime far in the future
    const avail = makeAvailability({ minNotice: 200000 });
    const slots = slotsForDay(avail, MON);
    assert.equal(slots.length, 0);
  });

  it('defaults eventDuration to 30 when not specified', () => {
    const avail = makeAvailability();
    delete avail.eventDuration;
    const slots = slotsForDay(avail, MON);
    // 09:00-12:00 / 30min = 6 slots
    assert.equal(slots.length, 6);
  });
});
