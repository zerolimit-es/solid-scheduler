import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { instantToNaive, zonedToInstant, parseNaive, addDays, naiveDiffMinutes, isValidTimeZone } from './tz.js';

describe('tz helpers', () => {
  it('converts instants to local wall time, independent of the server zone', () => {
    assert.equal(instantToNaive(new Date('2030-01-15T08:30:00Z'), 'Europe/Paris'), '2030-01-15 09:30');
    assert.equal(instantToNaive(new Date('2030-07-15T08:30:00Z'), 'Europe/Paris'), '2030-07-15 10:30');
    assert.equal(instantToNaive(new Date('2030-01-15T23:30:00Z'), 'Europe/Paris'), '2030-01-16 00:30');
  });

  it('converts wall time in a zone to the right instant, across DST', () => {
    assert.equal(zonedToInstant(2030, 1, 15, 9, 0, 'America/New_York').toISOString(), '2030-01-15T14:00:00.000Z');
    assert.equal(zonedToInstant(2030, 7, 15, 9, 0, 'America/New_York').toISOString(), '2030-07-15T13:00:00.000Z');
  });

  it('parses naive timestamps strictly', () => {
    assert.equal(parseNaive('2030-02-28 23:59').text, '2030-02-28 23:59');
    assert.equal(parseNaive('2030-02-28T09:05').text, '2030-02-28 09:05');
    for (const bad of ['2030-02-30 10:00', '2030-01-01 24:00', '2030-01-01 10:60', '2030-1-1 10:00', '', null]) {
      assert.equal(parseNaive(bad), null, String(bad));
    }
  });

  it('does calendar arithmetic', () => {
    assert.equal(addDays('2030-12-31', 1), '2031-01-01');
    assert.equal(addDays('2030-03-01', -1), '2030-02-28');
    assert.equal(naiveDiffMinutes('2030-01-01 23:00', '2030-01-02 01:30'), 150);
  });

  it('recognises IANA zones', () => {
    assert.equal(isValidTimeZone('Europe/Paris'), true);
    assert.equal(isValidTimeZone('Romance Standard Time'), false);
  });
});
