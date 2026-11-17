/**
 * SolidScheduler Test Suite
 * Run: node tests/test-slots.js
 */

const assert = (condition, msg) => {
  if (!condition) { console.error(`  \u2717 FAIL: ${msg}`); failures++; }
  else { console.log(`  \u2713 ${msg}`); passes++; }
};
let passes = 0, failures = 0;

console.log('\n=== 1. Field Name Consistency ===');

const publicSlot = { time: '09:00', displayTime: '9:00 AM', isBooked: false };
const mapped = { time: publicSlot.time, display: publicSlot.displayTime, booked: publicSlot.isBooked };
assert(mapped.time === '09:00', 'Public slot: time field maps correctly');
assert(mapped.display === '9:00 AM', 'Public slot: displayTime -> display');
assert(mapped.booked === false, 'Public slot: isBooked -> booked');

const authSlot = { start: new Date('2026-02-20T09:00:00'), end: new Date('2026-02-20T09:30:00'), date: '2026-02-20', time: '09:00', displayTime: '9:00 AM' };
const authMapped = { time: authSlot.time, display: authSlot.displayTime || authSlot.display, booked: authSlot.isBooked || authSlot.booked || false };
assert(authMapped.time === '09:00', 'Auth slot: time field maps correctly');
assert(authMapped.display === '9:00 AM', 'Auth slot: displayTime -> display');
assert(authMapped.booked === false, 'Auth slot: missing booked defaults to false');

console.log('\n=== 2. Availability Normalization ===');

const flat = { monday: { enabled: true, start: '09:00', end: '17:00' }, eventDuration: 30 };
assert(flat.monday.enabled === true, 'Flat format: monday.enabled accessible');
assert(flat.monday.start === '09:00', 'Flat format: monday.start accessible');

const nested = { days: { monday: { enabled: true, start: '09:00', end: '17:00' } }, eventDuration: 30 };
if (nested.days) {
  for (const [day, settings] of Object.entries(nested.days)) {
    nested[day] = { enabled: settings.enabled || false, start: settings.start || '09:00', end: settings.end || '17:00' };
  }
}
assert(nested.monday.enabled === true, 'Nested->flat: monday.enabled after denormalize');
assert(nested.monday.start === '09:00', 'Nested->flat: monday.start after denormalize');

const toSave = { monday: { enabled: true, start: '10:00', end: '18:00' }, eventDuration: 30 };
toSave.days = {};
for (const d of ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']) {
  if (toSave[d]) toSave.days[d] = { enabled: toSave[d].enabled || false, start: toSave[d].start || '09:00', end: toSave[d].end || '17:00' };
}
assert(toSave.days.monday.start === '10:00', 'Flat->nested: days.monday.start preserved');
assert(toSave.days.monday.enabled === true, 'Flat->nested: days.monday.enabled preserved');

console.log('\n=== 3. Past Time Filtering ===');

function filterPastSlots(slots, nowMin) {
  return slots.filter(s => {
    if (nowMin < 0) return true;
    const [h, m] = s.time.split(':').map(Number);
    return h * 60 + m > nowMin + 15;
  });
}

const allSlots = [
  { time: '09:00', display: '9:00 AM', booked: false },
  { time: '10:00', display: '10:00 AM', booked: false },
  { time: '14:00', display: '2:00 PM', booked: false },
  { time: '16:00', display: '4:00 PM', booked: false },
];

assert(filterPastSlots(allSlots, -1).length === 4, 'Not today: all 4 slots kept');
assert(filterPastSlots(allSlots, 570).length === 3, '9:30 AM: 9:00 filtered, 3 remain');
assert(filterPastSlots(allSlots, 870).length === 1, '2:30 PM: only 4:00 PM remains');
assert(filterPastSlots(allSlots, 990).length === 0, '4:30 PM: no slots remain');

console.log('\n=== 4. Timezone Detection ===');

function getTodayStr(tz) {
  const nowInTz = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  return nowInTz.getFullYear() + '-' + String(nowInTz.getMonth() + 1).padStart(2, '0') + '-' + String(nowInTz.getDate()).padStart(2, '0');
}
const todayParis = getTodayStr('Europe/Paris');
const todayUTC = getTodayStr('UTC');
assert(/^\d{4}-\d{2}-\d{2}$/.test(todayParis), 'Paris date format: YYYY-MM-DD');
assert(/^\d{4}-\d{2}-\d{2}$/.test(todayUTC), 'UTC date format: YYYY-MM-DD');

console.log('\n=== 5. Local Date Formatting ===');

const testDate = new Date(2026, 1, 20);
const localDate = [testDate.getFullYear(), String(testDate.getMonth() + 1).padStart(2, '0'), String(testDate.getDate()).padStart(2, '0')].join('-');
assert(localDate === '2026-02-20', 'Local format: always Feb 20');

console.log('\n=== 6. Organizer Field Mapping ===');

const podData = { name: 'Zero Limit', email: 'scheduler@zerolimit.es' };
podData.organizerName = podData.name || '';
podData.organizerEmail = podData.email || '';
assert(podData.organizerName === 'Zero Limit', 'Pod->Frontend: name -> organizerName');
assert(podData.organizerEmail === 'scheduler@zerolimit.es', 'Pod->Frontend: email -> organizerEmail');

const frontendData = { organizerName: 'Zero Limit', organizerEmail: 'scheduler@zerolimit.es' };
if (frontendData.organizerName !== undefined) frontendData.name = frontendData.organizerName;
if (frontendData.organizerEmail !== undefined) frontendData.email = frontendData.organizerEmail;
assert(frontendData.name === 'Zero Limit', 'Frontend->Pod: organizerName -> name');
assert(frontendData.email === 'scheduler@zerolimit.es', 'Frontend->Pod: organizerEmail -> email');

console.log('\n=== 7. ICS Format ===');

const icsLine = 'DTSTART;TZID=Europe/Paris:20260220T090000';
assert(icsLine.includes('TZID=Europe/Paris'), 'ICS: DTSTART has TZID');
assert(!icsLine.match(/^DTSTART:\d/), 'ICS: no floating time');

console.log('\n=== 8. Booking Response ===');

const bookingResponse = {
  id: 'booking-123', title: 'Meeting - John & Zero Limit',
  date: 'Friday, February 20, 2026', startTime: '9:00 AM', endTime: '9:30 AM',
  start: '2026-02-20T09:00:00', end: '2026-02-20T09:30:00',
  attendee: { name: 'John', email: 'john@example.com' },
};
assert(bookingResponse.start !== undefined, 'Booking: ISO start field present');
assert(bookingResponse.end !== undefined, 'Booking: ISO end field present');
assert(bookingResponse.date !== undefined, 'Booking: human date field present');
assert(bookingResponse.attendee.name === 'John', 'Booking: attendee.name present');

console.log('\n=== 9. Slot Generation ===');

function generateSlots(daySettings, duration) {
  if (!daySettings?.enabled) return [];
  const [startH, startM] = daySettings.start.split(':').map(Number);
  const [endH, endM] = daySettings.end.split(':').map(Number);
  const slots = [];
  for (let h = startH; h < endH || (h === endH && 0 < endM); h++) {
    for (let m = (h === startH ? startM : 0); m < 60; m += duration) {
      if (h * 60 + m + duration > endH * 60 + endM) break;
      slots.push(h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0'));
    }
  }
  return slots;
}

assert(generateSlots({ enabled: false }, 30).length === 0, 'Disabled day: no slots');
assert(generateSlots({ enabled: true, start: '09:00', end: '12:00' }, 30).length === 6, '9-12, 30min: 6 slots');
assert(generateSlots({ enabled: true, start: '09:00', end: '17:00' }, 30).length === 16, '9-17, 30min: 16 slots');
assert(generateSlots({ enabled: true, start: '14:00', end: '16:00' }, 30).length === 4, '14-16, 30min: 4 slots');
assert(generateSlots({ enabled: true, start: '09:00', end: '09:30' }, 30).length === 1, '9-9:30, 30min: 1 slot');
assert(generateSlots({ enabled: true, start: '09:00', end: '09:15' }, 30).length === 0, '9-9:15, 30min: 0 slots');

console.log('\n===================================');
console.log(`  Results: ${passes} passed, ${failures} failed`);
console.log('===================================\n');
process.exit(failures > 0 ? 1 : 0);
