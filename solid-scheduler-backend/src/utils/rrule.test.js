import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandRRule, validRRule } from './rrule.js';

/** Occurrences as naive local "YYYY-MM-DD HH:MM", the form stored times use. */
const expand = (...args) => expandRRule(...args).map((d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
  + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);

describe('expandRRule (blocked time)', () => {
  it('returns occurrences at the same local time', () => {
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=MO,WE', '2030-01-07 12:00', '2030-01-07 00:00', '2030-01-15 00:00'),
      ['2030-01-07 12:00', '2030-01-09 12:00', '2030-01-14 12:00']);
    // Across the European clock change at the end of March
    assert.deepEqual(expand('FREQ=WEEKLY', '2030-03-25 09:30', '2030-03-25 00:00', '2030-04-09 00:00'),
      ['2030-03-25 09:30', '2030-04-01 09:30', '2030-04-08 09:30']);
  });

  it('keeps blocking years after a daily block was created', () => {
    // More than 500 occurrences in: a daily lunch block from 2026 still blocks in 2032
    assert.deepEqual(expand('FREQ=DAILY', '2026-01-01 12:00', '2032-06-10 00:00', '2032-06-11 23:59'),
      ['2032-06-10 12:00', '2032-06-11 12:00']);
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-01-05 12:00', '2032-06-07 00:00', '2032-06-08 23:59'),
      ['2032-06-07 12:00', '2032-06-08 12:00']);
  });

  it('counts COUNT from the first occurrence, also with BYDAY', () => {
    const rule = 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3';
    assert.deepEqual(expand(rule, '2030-01-07 12:00', '2030-01-07 00:00', '2030-03-01 00:00'),
      ['2030-01-07 12:00', '2030-01-09 12:00', '2030-01-14 12:00']);
    assert.deepEqual(expand(rule, '2030-01-07 12:00', '2030-01-15 00:00', '2030-03-01 00:00'), [], 'ended before this range');
  });

  it('stops at UNTIL and leaves out excluded occurrences', () => {
    assert.deepEqual(expand('FREQ=DAILY;UNTIL=20300109', '2030-01-07 12:00', '2030-01-01 00:00', '2030-02-01 00:00'),
      ['2030-01-07 12:00', '2030-01-08 12:00', '2030-01-09 12:00']);
    assert.deepEqual(expand('FREQ=DAILY;COUNT=3', '2030-01-07 12:00', '2030-01-01 00:00', '2030-02-01 00:00', ['2030-01-08 12:00']),
      ['2030-01-07 12:00', '2030-01-09 12:00']);
  });

  it('defaults to weekly when the rule names no frequency, as before', () => {
    assert.deepEqual(expand('INTERVAL=1', '2030-01-07 12:00', '2030-01-07 00:00', '2030-01-15 00:00'),
      ['2030-01-07 12:00', '2030-01-14 12:00']);
  });
});

describe('validRRule', () => {
  it('accepts a repeat rule', () => {
    assert.equal(validRRule('FREQ=WEEKLY;BYDAY=MO,WE'), true);
  });
  it('refuses one without FREQ, with line breaks, or too long', () => {
    assert.equal(validRRule('BYDAY=MO'), false);
    assert.equal(validRRule('FREQ=WEEKLY\r\nATTENDEE:mailto:x@example.com'), false);
    assert.equal(validRRule(`FREQ=WEEKLY;${'BYDAY=MO;'.repeat(40)}`), false);
  });
});
