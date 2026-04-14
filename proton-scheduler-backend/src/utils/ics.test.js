import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateICS,
  generateRecurringICS,
  generateOccurrenceCancellationICS,
  generateCancellationICS,
  generateAvailabilityICS,
  parseICSEvent,
} from './ics.js';

// Helper: extract an unfolded property line from ICS content.
// Handles RFC 5545 line folding (continuation lines start with a space).
function getLine(ics, property) {
  const lines = ics.split('\r\n');
  const unfolded = [];
  for (const line of lines) {
    if (line.startsWith(' ') && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.substring(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded.find(l => l.startsWith(property + ':') || l.startsWith(property + ';'));
}

// Reusable test event — uses Date.UTC so UTC assertions are predictable
function makeEvent(overrides = {}) {
  return {
    title: 'Team Standup',
    start: new Date(Date.UTC(2025, 0, 6, 10, 0, 0)),
    end: new Date(Date.UTC(2025, 0, 6, 10, 30, 0)),
    organizer: { name: 'Alice Smith', email: 'alice@example.com' },
    attendee: { name: 'Bob Jones', email: 'bob@example.com' },
    uid: 'test-uid-123@solidscheduler.local',
    ...overrides,
  };
}

// ─── generateICS ─────────────────────────────────────────────────────

describe('generateICS', () => {
  it('uses CRLF line endings', () => {
    const ics = generateICS(makeEvent());
    // Every line break should be \r\n
    assert.ok(ics.includes('\r\n'));
    // No bare \n without preceding \r (except inside folded lines which still use \r\n)
    const withoutCRLF = ics.replaceAll('\r\n', '');
    assert.ok(!withoutCRLF.includes('\n'));
  });

  it('has required VCALENDAR envelope', () => {
    const ics = generateICS(makeEvent());
    assert.ok(ics.startsWith('BEGIN:VCALENDAR'));
    assert.ok(ics.includes('VERSION:2.0'));
    assert.ok(ics.includes('PRODID:'));
    assert.ok(ics.includes('CALSCALE:GREGORIAN'));
    assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  });

  it('has required VEVENT properties', () => {
    const ics = generateICS(makeEvent());
    assert.ok(ics.includes('BEGIN:VEVENT'));
    assert.ok(ics.includes('END:VEVENT'));
    assert.ok(getLine(ics, 'UID'));
    assert.ok(getLine(ics, 'DTSTAMP'));
    assert.ok(getLine(ics, 'DTSTART'));
    assert.ok(getLine(ics, 'DTEND'));
    assert.ok(getLine(ics, 'SUMMARY'));
  });

  it('formats DTSTART/DTEND as UTC with Z suffix (no timezone)', () => {
    const ics = generateICS(makeEvent());
    const dtstart = getLine(ics, 'DTSTART');
    const dtend = getLine(ics, 'DTEND');
    // UTC format: YYYYMMDDTHHMMSSZ
    assert.match(dtstart, /DTSTART:\d{8}T\d{6}Z$/);
    assert.match(dtend, /DTEND:\d{8}T\d{6}Z$/);
    assert.ok(dtstart.includes('20250106T100000Z'));
    assert.ok(dtend.includes('20250106T103000Z'));
  });

  it('formats DTSTART/DTEND with TZID when timezone is provided', () => {
    // Use local-time constructor since TZID path uses formatICSDateLocal
    const ics = generateICS({
      ...makeEvent(),
      start: new Date(2025, 0, 6, 10, 0, 0),
      end: new Date(2025, 0, 6, 10, 30, 0),
      timezone: 'Europe/Paris',
    });
    const dtstart = getLine(ics, 'DTSTART');
    const dtend = getLine(ics, 'DTEND');
    // TZID format: DTSTART;TZID=Europe/Paris:YYYYMMDDTHHMMSS (no Z)
    assert.match(dtstart, /DTSTART;TZID=Europe\/Paris:\d{8}T\d{6}$/);
    assert.match(dtend, /DTEND;TZID=Europe\/Paris:\d{8}T\d{6}$/);
    assert.ok(dtstart.includes('20250106T100000'));
    assert.ok(dtend.includes('20250106T103000'));
  });

  it('uses provided UID', () => {
    const ics = generateICS(makeEvent());
    assert.equal(getLine(ics, 'UID'), 'UID:test-uid-123@solidscheduler.local');
  });

  it('auto-generates UID when not provided', () => {
    const ics = generateICS(makeEvent({ uid: undefined }));
    const uidLine = getLine(ics, 'UID');
    assert.ok(uidLine);
    assert.ok(uidLine.endsWith('@solidscheduler.local'));
  });

  it('includes SUMMARY with event title', () => {
    const ics = generateICS(makeEvent());
    assert.equal(getLine(ics, 'SUMMARY'), 'SUMMARY:Team Standup');
  });

  it('includes DESCRIPTION when provided', () => {
    const ics = generateICS(makeEvent({ description: 'Daily sync meeting' }));
    assert.equal(getLine(ics, 'DESCRIPTION'), 'DESCRIPTION:Daily sync meeting');
  });

  it('omits DESCRIPTION when not provided', () => {
    const ics = generateICS(makeEvent());
    assert.equal(getLine(ics, 'DESCRIPTION'), undefined);
  });

  it('includes LOCATION when provided', () => {
    const ics = generateICS(makeEvent({ location: 'Conference Room A' }));
    assert.equal(getLine(ics, 'LOCATION'), 'LOCATION:Conference Room A');
  });

  it('omits LOCATION when not provided', () => {
    const ics = generateICS(makeEvent());
    assert.equal(getLine(ics, 'LOCATION'), undefined);
  });

  it('includes ORGANIZER with CN and mailto', () => {
    const ics = generateICS(makeEvent());
    const org = getLine(ics, 'ORGANIZER');
    assert.ok(org.includes('CN=Alice Smith'));
    assert.ok(org.includes('mailto:alice@example.com'));
  });

  it('includes ATTENDEE with CN, RSVP, and mailto', () => {
    const ics = generateICS(makeEvent());
    const att = getLine(ics, 'ATTENDEE');
    assert.ok(att.includes('CN=Bob Jones'));
    assert.ok(att.includes('RSVP=TRUE'));
    assert.ok(att.includes('PARTSTAT=NEEDS-ACTION'));
    assert.ok(att.includes('mailto:bob@example.com'));
  });

  it('omits ATTENDEE when not provided', () => {
    const ics = generateICS(makeEvent({ attendee: undefined }));
    assert.equal(getLine(ics, 'ATTENDEE'), undefined);
  });

  it('defaults to CONFIRMED status, sequence 0, REQUEST method', () => {
    const ics = generateICS(makeEvent());
    assert.equal(getLine(ics, 'STATUS'), 'STATUS:CONFIRMED');
    assert.equal(getLine(ics, 'SEQUENCE'), 'SEQUENCE:0');
    assert.equal(getLine(ics, 'METHOD'), 'METHOD:REQUEST');
  });

  it('uses custom status, sequence, and method', () => {
    const ics = generateICS(makeEvent({
      status: 'TENTATIVE',
      sequence: 3,
      method: 'PUBLISH',
    }));
    assert.equal(getLine(ics, 'STATUS'), 'STATUS:TENTATIVE');
    assert.equal(getLine(ics, 'SEQUENCE'), 'SEQUENCE:3');
    assert.equal(getLine(ics, 'METHOD'), 'METHOD:PUBLISH');
  });

  it('escapes special characters in text fields', () => {
    const ics = generateICS(makeEvent({
      title: 'Meeting; with, special\\chars\nand newline',
    }));
    const summary = getLine(ics, 'SUMMARY');
    assert.ok(summary.includes('\\;'));
    assert.ok(summary.includes('\\,'));
    assert.ok(summary.includes('\\\\'));
    assert.ok(summary.includes('\\n'));
  });

  it('escapes empty text as empty string', () => {
    const ics = generateICS(makeEvent({ description: '' }));
    // Empty description should not appear (falsy check in generateICS)
    assert.equal(getLine(ics, 'DESCRIPTION'), undefined);
  });

  it('folds long lines at 75 octets', () => {
    const longDesc = 'A'.repeat(200);
    const ics = generateICS(makeEvent({ description: longDesc }));
    const rawLines = ics.split('\r\n');
    // All raw lines (before unfolding) should be <= 75 chars
    for (const line of rawLines) {
      assert.ok(line.length <= 75, `Line too long (${line.length}): ${line.substring(0, 80)}...`);
    }
    // After unfolding, the full description should be intact
    const descLine = getLine(ics, 'DESCRIPTION');
    assert.ok(descLine.includes(longDesc));
  });

  it('includes RRULE for recurring events', () => {
    const ics = generateICS(makeEvent({
      recurrence: { frequency: 'WEEKLY', byDay: ['MO', 'WE', 'FR'], count: 10 },
    }));
    const rrule = getLine(ics, 'RRULE');
    assert.ok(rrule);
    assert.ok(rrule.includes('FREQ=WEEKLY'));
    assert.ok(rrule.includes('BYDAY=MO,WE,FR'));
    assert.ok(rrule.includes('COUNT=10'));
  });

  it('includes EXDATE for excluded dates', () => {
    const ics = generateICS(makeEvent({
      excludedDates: [
        new Date(Date.UTC(2025, 0, 8, 10, 0, 0)),
        new Date(Date.UTC(2025, 0, 13, 10, 0, 0)),
      ],
    }));
    const exdate = getLine(ics, 'EXDATE');
    assert.ok(exdate);
    assert.ok(exdate.includes('20250108T100000Z'));
    assert.ok(exdate.includes('20250113T100000Z'));
  });

  it('includes RECURRENCE-ID for exceptions', () => {
    const ics = generateICS(makeEvent({
      recurrenceId: new Date(Date.UTC(2025, 0, 8, 10, 0, 0)),
    }));
    const recId = getLine(ics, 'RECURRENCE-ID');
    assert.ok(recId);
    assert.ok(recId.includes('20250108T100000Z'));
  });

  it('RRULE buildRRuleString includes INTERVAL when > 1', () => {
    const ics = generateICS(makeEvent({
      recurrence: { frequency: 'DAILY', interval: 3 },
    }));
    const rrule = getLine(ics, 'RRULE');
    assert.ok(rrule.includes('INTERVAL=3'));
  });

  it('RRULE buildRRuleString omits INTERVAL when 1', () => {
    const ics = generateICS(makeEvent({
      recurrence: { frequency: 'DAILY', interval: 1 },
    }));
    const rrule = getLine(ics, 'RRULE');
    assert.ok(!rrule.includes('INTERVAL'));
  });

  it('RRULE buildRRuleString includes UNTIL', () => {
    const ics = generateICS(makeEvent({
      recurrence: { frequency: 'WEEKLY', until: new Date(Date.UTC(2025, 5, 1, 0, 0, 0)) },
    }));
    const rrule = getLine(ics, 'RRULE');
    assert.ok(rrule.includes('UNTIL=20250601T000000Z'));
  });

  it('RRULE buildRRuleString includes BYMONTH and BYMONTHDAY', () => {
    const ics = generateICS(makeEvent({
      recurrence: { frequency: 'YEARLY', byMonth: [1, 6], byMonthDay: [15] },
    }));
    const rrule = getLine(ics, 'RRULE');
    assert.ok(rrule.includes('BYMONTH=1,6'));
    assert.ok(rrule.includes('BYMONTHDAY=15'));
  });

  it('omits RRULE when recurrence has no frequency', () => {
    const ics = generateICS(makeEvent({ recurrence: {} }));
    assert.equal(getLine(ics, 'RRULE'), undefined);
  });
});

// ─── generateRecurringICS ────────────────────────────────────────────

describe('generateRecurringICS', () => {
  it('produces valid ICS with RRULE (delegates to generateICS)', () => {
    const event = makeEvent({
      recurrence: { frequency: 'WEEKLY', byDay: ['MO'], count: 4 },
    });
    const ics = generateRecurringICS(event);
    assert.ok(ics.includes('BEGIN:VCALENDAR'));
    assert.ok(ics.includes('RRULE:'));
    assert.ok(ics.includes('FREQ=WEEKLY'));
  });
});

// ─── generateCancellationICS ─────────────────────────────────────────

describe('generateCancellationICS', () => {
  it('sets CANCELLED status and CANCEL method', () => {
    const ics = generateCancellationICS(makeEvent());
    assert.equal(getLine(ics, 'STATUS'), 'STATUS:CANCELLED');
    assert.equal(getLine(ics, 'METHOD'), 'METHOD:CANCEL');
  });

  it('increments sequence number', () => {
    const ics = generateCancellationICS(makeEvent({ sequence: 2 }));
    assert.equal(getLine(ics, 'SEQUENCE'), 'SEQUENCE:3');
  });

  it('increments from default sequence 0', () => {
    const ics = generateCancellationICS(makeEvent());
    assert.equal(getLine(ics, 'SEQUENCE'), 'SEQUENCE:1');
  });

  it('prefixes description with CANCELLED:', () => {
    const ics = generateCancellationICS(makeEvent({ description: 'Weekly sync' }));
    const desc = getLine(ics, 'DESCRIPTION');
    assert.ok(desc.startsWith('DESCRIPTION:CANCELLED: Weekly sync'));
  });

  it('uses title in description when no description provided', () => {
    const ics = generateCancellationICS(makeEvent());
    const desc = getLine(ics, 'DESCRIPTION');
    assert.ok(desc.includes('CANCELLED: Team Standup'));
  });

  it('preserves original UID', () => {
    const ics = generateCancellationICS(makeEvent());
    assert.equal(getLine(ics, 'UID'), 'UID:test-uid-123@solidscheduler.local');
  });
});

// ─── generateOccurrenceCancellationICS ───────────────────────────────

describe('generateOccurrenceCancellationICS', () => {
  const occurrenceDate = new Date(Date.UTC(2025, 0, 13, 10, 0, 0)); // Jan 13

  it('sets CANCELLED status and CANCEL method', () => {
    const ics = generateOccurrenceCancellationICS(makeEvent(), occurrenceDate);
    assert.equal(getLine(ics, 'STATUS'), 'STATUS:CANCELLED');
    assert.equal(getLine(ics, 'METHOD'), 'METHOD:CANCEL');
  });

  it('increments sequence number', () => {
    const ics = generateOccurrenceCancellationICS(makeEvent({ sequence: 1 }), occurrenceDate);
    assert.equal(getLine(ics, 'SEQUENCE'), 'SEQUENCE:2');
  });

  it('sets RECURRENCE-ID to the occurrence date', () => {
    const ics = generateOccurrenceCancellationICS(makeEvent(), occurrenceDate);
    const recId = getLine(ics, 'RECURRENCE-ID');
    assert.ok(recId);
    assert.ok(recId.includes('20250113T100000Z'));
  });

  it('removes recurrence rule', () => {
    const event = makeEvent({
      recurrence: { frequency: 'WEEKLY', count: 10 },
    });
    const ics = generateOccurrenceCancellationICS(event, occurrenceDate);
    assert.equal(getLine(ics, 'RRULE'), undefined);
  });

  it('sets start to occurrence date and preserves duration', () => {
    const event = makeEvent(); // 10:00-10:30 = 30min
    const ics = generateOccurrenceCancellationICS(event, occurrenceDate);
    const dtstart = getLine(ics, 'DTSTART');
    const dtend = getLine(ics, 'DTEND');
    assert.ok(dtstart.includes('20250113T100000Z'));
    assert.ok(dtend.includes('20250113T103000Z'));
  });

  it('preserves original UID', () => {
    const ics = generateOccurrenceCancellationICS(makeEvent(), occurrenceDate);
    assert.equal(getLine(ics, 'UID'), 'UID:test-uid-123@solidscheduler.local');
  });
});

// ─── generateAvailabilityICS ─────────────────────────────────────────

describe('generateAvailabilityICS', () => {
  const availability = {
    name: 'Alice',
    email: 'alice@example.com',
    days: {
      sunday: { enabled: false },
      monday: { enabled: true, start: '09:00', end: '17:00' },
      tuesday: { enabled: true, start: '09:00', end: '17:00' },
      wednesday: { enabled: true, start: '09:00', end: '17:00' },
      thursday: { enabled: true, start: '09:00', end: '17:00' },
      friday: { enabled: true, start: '09:00', end: '12:00' },
      saturday: { enabled: false },
    },
  };

  it('has VCALENDAR envelope with METHOD:PUBLISH', () => {
    const ics = generateAvailabilityICS(availability);
    assert.ok(ics.includes('BEGIN:VCALENDAR'));
    assert.ok(ics.includes('METHOD:PUBLISH'));
    assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  });

  it('has VFREEBUSY component', () => {
    const ics = generateAvailabilityICS(availability);
    assert.ok(ics.includes('BEGIN:VFREEBUSY'));
    assert.ok(ics.includes('END:VFREEBUSY'));
  });

  it('includes ORGANIZER', () => {
    const ics = generateAvailabilityICS(availability);
    const org = getLine(ics, 'ORGANIZER');
    assert.ok(org.includes('CN=Alice'));
    assert.ok(org.includes('mailto:alice@example.com'));
  });

  it('generates FREEBUSY periods for enabled days', () => {
    const ics = generateAvailabilityICS(availability);
    // With 5 enabled weekdays over 4 weeks, there should be some FREEBUSY lines
    // (exact count depends on current date, but at least some should be in the future)
    const freebusyLines = ics.split('\r\n').filter(l => l.startsWith('FREEBUSY'));
    assert.ok(freebusyLines.length > 0, 'Should have at least one FREEBUSY period');
    // Each line should have FBTYPE=FREE and datetime/datetime format (UTC with Z)
    for (const line of freebusyLines) {
      assert.ok(line.includes('FBTYPE=FREE'));
      assert.match(line, /\d{8}T\d{6}Z\/\d{8}T\d{6}Z/);
    }
  });

  it('produces no FREEBUSY when all days disabled', () => {
    const disabled = {
      name: 'Alice',
      email: 'alice@example.com',
      days: {
        sunday: { enabled: false },
        monday: { enabled: false },
        tuesday: { enabled: false },
        wednesday: { enabled: false },
        thursday: { enabled: false },
        friday: { enabled: false },
        saturday: { enabled: false },
      },
    };
    const ics = generateAvailabilityICS(disabled);
    const freebusyLines = ics.split('\r\n').filter(l => l.startsWith('FREEBUSY'));
    assert.equal(freebusyLines.length, 0);
  });

  it('uses CRLF line endings', () => {
    const ics = generateAvailabilityICS(availability);
    assert.ok(ics.includes('\r\n'));
  });
});

// ─── parseICSEvent ───────────────────────────────────────────────────

describe('parseICSEvent', () => {
  // Generate a known ICS to parse
  const event = makeEvent({ description: 'A test meeting', location: 'Room 42' });
  const ics = generateICS(event);

  it('parses UID', () => {
    const parsed = parseICSEvent(ics);
    assert.equal(parsed.uid, 'test-uid-123@solidscheduler.local');
  });

  it('parses SUMMARY as title', () => {
    const parsed = parseICSEvent(ics);
    assert.equal(parsed.title, 'Team Standup');
  });

  it('parses DESCRIPTION', () => {
    const parsed = parseICSEvent(ics);
    assert.equal(parsed.description, 'A test meeting');
  });

  it('parses DTSTART and DTEND as Date objects', () => {
    const parsed = parseICSEvent(ics);
    assert.ok(parsed.start instanceof Date);
    assert.ok(parsed.end instanceof Date);
    assert.ok(!isNaN(parsed.start.getTime()));
    assert.ok(!isNaN(parsed.end.getTime()));
  });

  it('parses LOCATION', () => {
    const parsed = parseICSEvent(ics);
    assert.equal(parsed.location, 'Room 42');
  });

  it('parses STATUS', () => {
    const parsed = parseICSEvent(ics);
    assert.equal(parsed.status, 'CONFIRMED');
  });

  it('unescapes commas and newlines in text fields', () => {
    const escapedICS = generateICS(makeEvent({
      title: 'Meeting, with comma',
      description: 'Line one\nLine two',
    }));
    const parsed = parseICSEvent(escapedICS);
    assert.equal(parsed.title, 'Meeting, with comma');
    assert.equal(parsed.description, 'Line one\nLine two');
  });

  it('unfolds continuation lines', () => {
    // Create ICS with a long description that will be folded
    const longTitle = 'A'.repeat(100);
    const foldedICS = generateICS(makeEvent({ title: longTitle }));
    const parsed = parseICSEvent(foldedICS);
    assert.equal(parsed.title, longTitle);
  });

  it('returns null when UID is missing', () => {
    const noUID = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Test\r\nEND:VEVENT\r\nEND:VCALENDAR';
    assert.equal(parseICSEvent(noUID), null);
  });

  it('returns null for invalid input', () => {
    assert.equal(parseICSEvent('not valid ics content'), null);
  });

  it('handles ORGANIZER line with colons in mailto', () => {
    // The parser splits on : but should reassemble value correctly
    const parsed = parseICSEvent(ics);
    // Should not crash; organizer isn't parsed by parseICSEvent,
    // but the line shouldn't break other parsing
    assert.ok(parsed.uid);
    assert.ok(parsed.title);
  });

  it('roundtrips title and UID through generate+parse', () => {
    const original = makeEvent({ title: 'Roundtrip Test' });
    const generated = generateICS(original);
    const parsed = parseICSEvent(generated);
    assert.equal(parsed.uid, original.uid);
    assert.equal(parsed.title, original.title);
  });
});
