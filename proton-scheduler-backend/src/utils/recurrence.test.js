import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRRule,
  buildRRule,
  generateOccurrences,
  describeRecurrence,
  getNextOccurrence,
  isSameOccurrence,
  generateSeriesId,
  expandRecurringEvent,
  RECURRENCE_PRESETS,
} from './recurrence.js';

// Helper: create a local date at 10:00 AM to avoid UTC date-shift issues.
// Month is 1-based (1=Jan) for readability.
const date = (y, m, d) => new Date(y, m - 1, d, 10, 0, 0);

// ─── parseRRule ──────────────────────────────────────────────────────

describe('parseRRule', () => {
  it('returns null for null/undefined/empty input', () => {
    assert.equal(parseRRule(null), null);
    assert.equal(parseRRule(undefined), null);
    assert.equal(parseRRule(''), null);
  });

  it('parses basic FREQ', () => {
    const rule = parseRRule('FREQ=DAILY');
    assert.equal(rule.frequency, 'DAILY');
  });

  it('strips RRULE: prefix', () => {
    const rule = parseRRule('RRULE:FREQ=WEEKLY');
    assert.equal(rule.frequency, 'WEEKLY');
  });

  it('parses INTERVAL', () => {
    const rule = parseRRule('FREQ=DAILY;INTERVAL=3');
    assert.equal(rule.interval, 3);
  });

  it('parses COUNT', () => {
    const rule = parseRRule('FREQ=DAILY;COUNT=10');
    assert.equal(rule.count, 10);
  });

  it('parses UNTIL date-only (YYYYMMDD)', () => {
    const rule = parseRRule('FREQ=DAILY;UNTIL=20250131');
    assert.equal(rule.until.getFullYear(), 2025);
    assert.equal(rule.until.getMonth(), 0);
    assert.equal(rule.until.getDate(), 31);
  });

  it('parses UNTIL datetime (YYYYMMDDTHHMMSSZ)', () => {
    const rule = parseRRule('FREQ=DAILY;UNTIL=20250131T120000Z');
    assert.equal(rule.until.getUTCFullYear(), 2025);
    assert.equal(rule.until.getUTCMonth(), 0);
    assert.equal(rule.until.getUTCDate(), 31);
    assert.equal(rule.until.getUTCHours(), 12);
  });

  it('parses BYDAY', () => {
    const rule = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    assert.deepEqual(rule.byDay, ['MO', 'WE', 'FR']);
  });

  it('parses BYMONTH', () => {
    const rule = parseRRule('FREQ=YEARLY;BYMONTH=1,6,12');
    assert.deepEqual(rule.byMonth, [1, 6, 12]);
  });

  it('parses BYMONTHDAY', () => {
    const rule = parseRRule('FREQ=MONTHLY;BYMONTHDAY=1,15,-1');
    assert.deepEqual(rule.byMonthDay, [1, 15, -1]);
  });

  it('parses BYSETPOS', () => {
    const rule = parseRRule('FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2');
    assert.deepEqual(rule.bySetPos, [2]);
  });

  it('parses WKST', () => {
    const rule = parseRRule('FREQ=WEEKLY;WKST=SU');
    assert.equal(rule.weekStart, 'SU');
  });

  it('parses complex multi-part rule', () => {
    const rule = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10;WKST=SU');
    assert.equal(rule.frequency, 'WEEKLY');
    assert.equal(rule.interval, 2);
    assert.deepEqual(rule.byDay, ['MO', 'WE', 'FR']);
    assert.equal(rule.count, 10);
    assert.equal(rule.weekStart, 'SU');
  });

  it('handles case insensitivity', () => {
    const rule = parseRRule('freq=daily;interval=2;byday=mo,we');
    assert.equal(rule.frequency, 'DAILY');
    assert.equal(rule.interval, 2);
    assert.deepEqual(rule.byDay, ['MO', 'WE']);
  });
});

// ─── buildRRule ──────────────────────────────────────────────────────

describe('buildRRule', () => {
  it('returns empty string for null/undefined/missing frequency', () => {
    assert.equal(buildRRule(null), '');
    assert.equal(buildRRule(undefined), '');
    assert.equal(buildRRule({}), '');
  });

  it('builds basic FREQ', () => {
    assert.equal(buildRRule({ frequency: 'DAILY' }), 'FREQ=DAILY');
  });

  it('omits INTERVAL when 1', () => {
    const result = buildRRule({ frequency: 'DAILY', interval: 1 });
    assert.equal(result, 'FREQ=DAILY');
  });

  it('includes INTERVAL when > 1', () => {
    const result = buildRRule({ frequency: 'WEEKLY', interval: 2 });
    assert.equal(result, 'FREQ=WEEKLY;INTERVAL=2');
  });

  it('includes COUNT', () => {
    const result = buildRRule({ frequency: 'DAILY', count: 5 });
    assert.equal(result, 'FREQ=DAILY;COUNT=5');
  });

  it('includes UNTIL formatted as YYYYMMDDTHHMMSSZ', () => {
    const result = buildRRule({
      frequency: 'DAILY',
      until: new Date(Date.UTC(2025, 0, 31, 12, 0, 0)),
    });
    assert.equal(result, 'FREQ=DAILY;UNTIL=20250131T120000Z');
  });

  it('COUNT takes precedence over UNTIL', () => {
    const result = buildRRule({
      frequency: 'DAILY',
      count: 5,
      until: new Date(2025, 5, 1),
    });
    assert.ok(result.includes('COUNT=5'));
    assert.ok(!result.includes('UNTIL'));
  });

  it('includes BYDAY', () => {
    const result = buildRRule({ frequency: 'WEEKLY', byDay: ['MO', 'FR'] });
    assert.ok(result.includes('BYDAY=MO,FR'));
  });

  it('includes BYMONTH', () => {
    const result = buildRRule({ frequency: 'YEARLY', byMonth: [1, 6] });
    assert.ok(result.includes('BYMONTH=1,6'));
  });

  it('includes BYMONTHDAY', () => {
    const result = buildRRule({ frequency: 'MONTHLY', byMonthDay: [15, -1] });
    assert.ok(result.includes('BYMONTHDAY=15,-1'));
  });

  it('includes BYSETPOS', () => {
    const result = buildRRule({ frequency: 'MONTHLY', byDay: ['MO'], bySetPos: [2] });
    assert.ok(result.includes('BYSETPOS=2'));
  });

  it('omits WKST when MO (default)', () => {
    const result = buildRRule({ frequency: 'WEEKLY', weekStart: 'MO' });
    assert.ok(!result.includes('WKST'));
  });

  it('includes WKST when not MO', () => {
    const result = buildRRule({ frequency: 'WEEKLY', weekStart: 'SU' });
    assert.ok(result.includes('WKST=SU'));
  });

  it('roundtrips with parseRRule', () => {
    const original = { frequency: 'WEEKLY', interval: 2, byDay: ['MO', 'WE', 'FR'], count: 10 };
    const rrule = buildRRule(original);
    const parsed = parseRRule(rrule);
    assert.equal(parsed.frequency, original.frequency);
    assert.equal(parsed.interval, original.interval);
    assert.deepEqual(parsed.byDay, original.byDay);
    assert.equal(parsed.count, original.count);
  });
});

// ─── generateOccurrences ────────────────────────────────────────────

describe('generateOccurrences', () => {
  it('returns single date when no rule', () => {
    const start = date(2025, 1, 6);
    const result = generateOccurrences(start, null);
    assert.equal(result.length, 1);
    assert.equal(result[0].getTime(), start.getTime());
  });

  it('returns single date when rule has no frequency', () => {
    const start = date(2025, 1, 6);
    const result = generateOccurrences(start, {});
    assert.equal(result.length, 1);
  });

  it('generates DAILY occurrences with COUNT', () => {
    const start = date(2025, 1, 6); // Mon Jan 6
    const result = generateOccurrences(start, { frequency: 'DAILY', count: 5 }, {
      rangeEnd: date(2025, 2, 1),
    });
    assert.equal(result.length, 5);
    assert.equal(result[0].getDate(), 6);
    assert.equal(result[1].getDate(), 7);
    assert.equal(result[2].getDate(), 8);
    assert.equal(result[3].getDate(), 9);
    assert.equal(result[4].getDate(), 10);
  });

  it('generates DAILY occurrences with INTERVAL', () => {
    const start = date(2025, 1, 6);
    const result = generateOccurrences(start, { frequency: 'DAILY', interval: 2, count: 3 }, {
      rangeEnd: date(2025, 2, 1),
    });
    assert.equal(result.length, 3);
    assert.equal(result[0].getDate(), 6);
    assert.equal(result[1].getDate(), 8);  // +2 days
    assert.equal(result[2].getDate(), 10); // +2 days
  });

  it('generates DAILY occurrences with UNTIL', () => {
    const start = date(2025, 1, 6);
    const until = date(2025, 1, 9); // Jan 9 inclusive
    const result = generateOccurrences(start, { frequency: 'DAILY', until }, {
      rangeEnd: date(2025, 2, 1),
    });
    assert.equal(result.length, 4); // Jan 6, 7, 8, 9
    assert.equal(result[0].getDate(), 6);
    assert.equal(result[3].getDate(), 9);
  });

  it('generates WEEKLY occurrences (no BYDAY)', () => {
    const start = date(2025, 1, 6); // Monday
    const result = generateOccurrences(start, { frequency: 'WEEKLY', count: 3 }, {
      rangeEnd: date(2025, 3, 1),
    });
    assert.equal(result.length, 3);
    assert.equal(result[0].getDate(), 6);  // Jan 6
    assert.equal(result[1].getDate(), 13); // Jan 13
    assert.equal(result[2].getDate(), 20); // Jan 20
  });

  it('WEEKLY with BYDAY generates occurrences on all specified days', () => {
    // With BYDAY=MO,WE,FR starting on a Monday, the first 6 occurrences
    // should be Mon/Wed/Fri of the first 2 weeks.
    const start = date(2025, 1, 6); // Monday
    const rule = { frequency: 'WEEKLY', byDay: ['MO', 'WE', 'FR'], count: 6 };
    const result = generateOccurrences(start, rule, {
      rangeEnd: date(2025, 3, 1),
    });
    assert.equal(result.length, 6);
    const days = result.map(d => d.getDay());
    // MO=1, WE=3, FR=5
    assert.deepEqual(days, [1, 3, 5, 1, 3, 5]);
  });

  it('WEEKLY with INTERVAL > 1 skips intermediate weeks', () => {
    const start = date(2025, 1, 6); // Monday
    const result = generateOccurrences(start, { frequency: 'WEEKLY', interval: 2, count: 3 }, {
      rangeEnd: date(2025, 3, 1),
    });
    assert.equal(result.length, 3);
    // Every 2 weeks: Jan 6, Jan 20, Feb 3
    assert.equal(result[0].getDate(), 6);
    assert.equal(result[0].getMonth(), 0); // Jan
    assert.equal(result[1].getDate(), 20);
    assert.equal(result[1].getMonth(), 0); // Jan
    assert.equal(result[2].getDate(), 3);
    assert.equal(result[2].getMonth(), 1); // Feb
  });

  it('generates MONTHLY occurrences', () => {
    const start = date(2025, 1, 15);
    const result = generateOccurrences(start, { frequency: 'MONTHLY', count: 3 }, {
      rangeEnd: date(2025, 6, 1),
    });
    assert.equal(result.length, 3);
    assert.equal(result[0].getMonth(), 0); // Jan
    assert.equal(result[1].getMonth(), 1); // Feb
    assert.equal(result[2].getMonth(), 2); // Mar
    // All on the 15th
    result.forEach(d => assert.equal(d.getDate(), 15));
  });

  it('generates YEARLY occurrences', () => {
    const start = date(2025, 3, 15); // Mar 15
    const result = generateOccurrences(start, { frequency: 'YEARLY', count: 3 }, {
      rangeEnd: date(2028, 1, 1),
    });
    assert.equal(result.length, 3);
    assert.equal(result[0].getFullYear(), 2025);
    assert.equal(result[1].getFullYear(), 2026);
    assert.equal(result[2].getFullYear(), 2027);
  });

  it('excludes specified dates', () => {
    const start = date(2025, 1, 6);
    const result = generateOccurrences(
      start,
      { frequency: 'DAILY', count: 4 },
      {
        rangeEnd: date(2025, 2, 1),
        excludedDates: [date(2025, 1, 8)], // Exclude Jan 8
      },
    );
    assert.equal(result.length, 4);
    const dates = result.map(d => d.getDate());
    // Jan 8 skipped, so: 6, 7, 9, 10
    assert.deepEqual(dates, [6, 7, 9, 10]);
  });

  it('respects rangeStart and rangeEnd', () => {
    const start = date(2025, 1, 1);
    const result = generateOccurrences(
      start,
      { frequency: 'DAILY' },
      {
        rangeStart: date(2025, 1, 5),
        rangeEnd: date(2025, 1, 8),
        maxOccurrences: 100,
      },
    );
    const dates = result.map(d => d.getDate());
    // Only Jan 5, 6, 7, 8 are in range
    assert.deepEqual(dates, [5, 6, 7, 8]);
  });

  it('respects maxOccurrences', () => {
    const start = date(2025, 1, 1);
    const result = generateOccurrences(
      start,
      { frequency: 'DAILY' },
      { rangeEnd: date(2025, 12, 31), maxOccurrences: 3 },
    );
    assert.equal(result.length, 3);
  });

  it('MONTHLY with BYMONTHDAY', () => {
    const start = date(2025, 1, 15);
    const result = generateOccurrences(
      start,
      { frequency: 'MONTHLY', byMonthDay: [15], count: 3 },
      { rangeEnd: date(2025, 6, 1) },
    );
    assert.equal(result.length, 3);
    result.forEach(d => assert.equal(d.getDate(), 15));
  });

  it('MONTHLY with negative BYMONTHDAY (last day of month)', () => {
    const start = date(2025, 1, 31); // Jan 31
    const result = generateOccurrences(
      start,
      { frequency: 'MONTHLY', byMonthDay: [-1], count: 3 },
      { rangeEnd: date(2025, 6, 1) },
    );
    assert.equal(result.length, 3);
    // Last day: Jan 31, Feb 28, Mar 31
    assert.equal(result[0].getDate(), 31);
    assert.equal(result[1].getDate(), 28);
    assert.equal(result[2].getDate(), 31);
  });

  it('DAILY with BYDAY filters to matching days only', () => {
    const start = date(2025, 1, 6); // Monday
    const result = generateOccurrences(
      start,
      { frequency: 'DAILY', byDay: ['MO', 'WE', 'FR'] },
      { rangeEnd: date(2025, 1, 20), maxOccurrences: 6 },
    );
    assert.equal(result.length, 6);
    const days = result.map(d => d.getDay());
    assert.deepEqual(days, [1, 3, 5, 1, 3, 5]); // MO, WE, FR x2
  });
});

// ─── describeRecurrence ─────────────────────────────────────────────

describe('describeRecurrence', () => {
  it('returns "Does not repeat" for null/empty', () => {
    assert.equal(describeRecurrence(null), 'Does not repeat');
    assert.equal(describeRecurrence({}), 'Does not repeat');
  });

  it('describes DAILY', () => {
    assert.equal(describeRecurrence({ frequency: 'DAILY' }), 'Daily');
  });

  it('describes WEEKLY', () => {
    assert.equal(describeRecurrence({ frequency: 'WEEKLY' }), 'Weekly');
  });

  it('describes MONTHLY', () => {
    assert.equal(describeRecurrence({ frequency: 'MONTHLY' }), 'Monthly');
  });

  it('describes YEARLY', () => {
    assert.equal(describeRecurrence({ frequency: 'YEARLY' }), 'Yearly');
  });

  it('describes intervals > 1', () => {
    assert.equal(describeRecurrence({ frequency: 'DAILY', interval: 3 }), 'Every 3 days');
    assert.equal(describeRecurrence({ frequency: 'WEEKLY', interval: 2 }), 'Every 2 weeks');
    assert.equal(describeRecurrence({ frequency: 'MONTHLY', interval: 4 }), 'Every 4 months');
    assert.equal(describeRecurrence({ frequency: 'YEARLY', interval: 2 }), 'Every 2 years');
  });

  it('describes BYDAY with day names', () => {
    const result = describeRecurrence({ frequency: 'WEEKLY', byDay: ['MO', 'WE', 'FR'] });
    assert.equal(result, 'Weekly on Monday, Wednesday, Friday');
  });

  it('describes nth weekday (e.g., 2MO = second Monday)', () => {
    const result = describeRecurrence({ frequency: 'MONTHLY', byDay: ['2MO'] });
    assert.equal(result, 'Monthly on second Monday');
  });

  it('describes last weekday (-1FR)', () => {
    const result = describeRecurrence({ frequency: 'MONTHLY', byDay: ['-1FR'] });
    assert.equal(result, 'Monthly on last Friday');
  });

  it('describes COUNT', () => {
    const result = describeRecurrence({ frequency: 'DAILY', count: 5 });
    assert.equal(result, 'Daily for 5 times');
  });

  it('describes UNTIL', () => {
    const result = describeRecurrence({ frequency: 'WEEKLY', until: date(2025, 6, 1) });
    assert.ok(result.startsWith('Weekly until'));
  });
});

// ─── getNextOccurrence ──────────────────────────────────────────────

describe('getNextOccurrence', () => {
  it('returns the next occurrence after a given date', () => {
    const start = date(2025, 1, 6); // Monday
    const after = date(2025, 1, 8);
    const next = getNextOccurrence(start, { frequency: 'DAILY' }, after);
    assert.ok(next);
    assert.equal(next.getDate(), 8);
  });

  it('returns null when all occurrences are before afterDate', () => {
    const start = date(2025, 1, 6);
    const rule = { frequency: 'DAILY', until: date(2025, 1, 8) };
    const after = date(2025, 1, 10);
    const next = getNextOccurrence(start, rule, after);
    assert.equal(next, null);
  });
});

// ─── isSameOccurrence ───────────────────────────────────────────────

describe('isSameOccurrence', () => {
  it('returns true for same day at different times', () => {
    const a = new Date(2025, 0, 6, 10, 0, 0);
    const b = new Date(2025, 0, 6, 15, 30, 0);
    assert.equal(isSameOccurrence(a, b), true);
  });

  it('returns false for different days', () => {
    const a = new Date(2025, 0, 6, 10, 0, 0);
    const b = new Date(2025, 0, 7, 10, 0, 0);
    assert.equal(isSameOccurrence(a, b), false);
  });
});

// ─── generateSeriesId ───────────────────────────────────────────────

describe('generateSeriesId', () => {
  it('returns a string starting with "series-"', () => {
    const id = generateSeriesId();
    assert.ok(id.startsWith('series-'));
  });

  it('generates unique IDs', () => {
    const a = generateSeriesId();
    const b = generateSeriesId();
    assert.notEqual(a, b);
  });
});

// ─── expandRecurringEvent ───────────────────────────────────────────

describe('expandRecurringEvent', () => {
  it('wraps non-recurring event in a single occurrence', () => {
    const event = {
      id: 'evt-1',
      start: date(2025, 1, 6),
      end: new Date(2025, 0, 6, 10, 30, 0),
      title: 'Meeting',
    };
    const result = expandRecurringEvent(event);
    assert.equal(result.length, 1);
    assert.equal(result[0].isRecurring, false);
    assert.equal(result[0].title, 'Meeting');
  });

  it('expands recurring event into multiple occurrences', () => {
    const event = {
      id: 'evt-1',
      start: date(2025, 1, 6),
      end: new Date(2025, 0, 6, 10, 30, 0),
      recurrence: { frequency: 'DAILY', count: 3 },
    };
    const result = expandRecurringEvent(event, {
      rangeEnd: date(2025, 2, 1),
    });
    assert.equal(result.length, 3);
    result.forEach(occ => {
      assert.equal(occ.isRecurring, true);
      assert.ok(occ.id.startsWith('evt-1_'));
      assert.equal(occ.seriesId, 'evt-1');
    });
  });

  it('preserves event duration across occurrences', () => {
    const start = date(2025, 1, 6);
    const end = new Date(start.getTime() + 30 * 60 * 1000); // +30min
    const event = {
      id: 'evt-1',
      start,
      end,
      recurrence: { frequency: 'DAILY', count: 3 },
    };
    const result = expandRecurringEvent(event, {
      rangeEnd: date(2025, 2, 1),
    });
    result.forEach(occ => {
      const duration = occ.end.getTime() - occ.start.getTime();
      assert.equal(duration, 30 * 60 * 1000);
    });
  });

  it('skips excluded dates', () => {
    const event = {
      id: 'evt-1',
      start: date(2025, 1, 6),
      end: new Date(2025, 0, 6, 10, 30, 0),
      recurrence: { frequency: 'DAILY', count: 3 },
      excludedDates: [date(2025, 1, 7)],
    };
    const result = expandRecurringEvent(event, {
      rangeEnd: date(2025, 2, 1),
    });
    // Jan 7 excluded; count=3 still fills 3 results: Jan 6, 8, 9
    assert.equal(result.length, 3);
    const dates = result.map(o => o.start.getDate());
    assert.ok(!dates.includes(7));
  });

  it('applies exceptions to matching occurrences', () => {
    const event = {
      id: 'evt-1',
      start: date(2025, 1, 6),
      end: new Date(2025, 0, 6, 10, 30, 0),
      recurrence: { frequency: 'DAILY', count: 3 },
      exceptions: [{
        originalDate: date(2025, 1, 7),
        title: 'Modified meeting',
      }],
    };
    const result = expandRecurringEvent(event, {
      rangeEnd: date(2025, 2, 1),
    });
    assert.equal(result.length, 3);

    const modified = result.find(o => o.isException);
    assert.ok(modified);
    assert.equal(modified.title, 'Modified meeting');
    assert.equal(modified.isException, true);

    const normal = result.filter(o => !o.isException);
    assert.equal(normal.length, 2);
    normal.forEach(o => assert.equal(o.isException, false));
  });

  it('uses event.seriesId when available', () => {
    const event = {
      id: 'evt-1',
      seriesId: 'custom-series',
      start: date(2025, 1, 6),
      end: new Date(2025, 0, 6, 10, 30, 0),
      recurrence: { frequency: 'DAILY', count: 2 },
    };
    const result = expandRecurringEvent(event, {
      rangeEnd: date(2025, 2, 1),
    });
    result.forEach(occ => assert.equal(occ.seriesId, 'custom-series'));
  });
});

// ─── RECURRENCE_PRESETS ─────────────────────────────────────────────

describe('RECURRENCE_PRESETS', () => {
  it('has all expected preset keys', () => {
    const keys = Object.keys(RECURRENCE_PRESETS);
    assert.ok(keys.includes('none'));
    assert.ok(keys.includes('daily'));
    assert.ok(keys.includes('weekdays'));
    assert.ok(keys.includes('weekly'));
    assert.ok(keys.includes('biweekly'));
    assert.ok(keys.includes('monthly'));
    assert.ok(keys.includes('yearly'));
  });

  it('none preset is null', () => {
    assert.equal(RECURRENCE_PRESETS.none, null);
  });

  it('weekdays preset covers Mon-Fri', () => {
    const wd = RECURRENCE_PRESETS.weekdays;
    assert.equal(wd.frequency, 'WEEKLY');
    assert.deepEqual(wd.byDay, ['MO', 'TU', 'WE', 'TH', 'FR']);
  });

  it('biweekly preset has interval 2', () => {
    assert.equal(RECURRENCE_PRESETS.biweekly.frequency, 'WEEKLY');
    assert.equal(RECURRENCE_PRESETS.biweekly.interval, 2);
  });
});
