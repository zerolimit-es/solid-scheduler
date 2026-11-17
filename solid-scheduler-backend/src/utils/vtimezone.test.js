import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildVTimezone } from './vtimezone.js';

describe('buildVTimezone', () => {
  it('lists the DST changes of a zone with their wall-clock onsets', () => {
    const lines = buildVTimezone('Europe/Paris', { fromYear: 2030, toYear: 2030 });
    assert.deepEqual(lines, [
      'BEGIN:VTIMEZONE', 'TZID:Europe/Paris',
      'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100', 'END:STANDARD',
      'BEGIN:DAYLIGHT', 'DTSTART:20300331T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
      'BEGIN:STANDARD', 'DTSTART:20301027T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'END:STANDARD',
      'END:VTIMEZONE',
    ]);
  });

  it('handles zones west of UTC and the southern hemisphere', () => {
    const ny = buildVTimezone('America/New_York', { fromYear: 2030, toYear: 2030 });
    assert.ok(ny.includes('DTSTART:20300310T020000') && ny.includes('TZOFFSETTO:-0400'));
    const sydney = buildVTimezone('Australia/Sydney', { fromYear: 2030, toYear: 2030 });
    assert.equal(sydney[4], 'TZOFFSETFROM:+1100', 'summer time at the start of the year');
    assert.ok(sydney.includes('BEGIN:DAYLIGHT'));
  });

  it('gives a single observance for a zone without DST, including half-hour offsets', () => {
    assert.equal(buildVTimezone('Asia/Tokyo', { fromYear: 2030, toYear: 2031 }).length, 8);
    assert.ok(buildVTimezone('Asia/Kolkata', { fromYear: 2030, toYear: 2030 }).includes('TZOFFSETTO:+0530'));
  });

  it('returns nothing for an unknown timezone', () => {
    assert.deepEqual(buildVTimezone('Mars/Olympus'), []);
    assert.deepEqual(buildVTimezone(undefined), []);
  });
});
