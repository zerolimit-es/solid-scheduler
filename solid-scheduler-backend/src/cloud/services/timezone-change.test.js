import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertNaive, shiftRuleDays } from './timezone-change.js';

describe('convertNaive', () => {
  it('keeps the moment: 10:00 in Paris is 18:00 in Tokyo in winter, 17:00 in summer', () => {
    assert.equal(convertNaive('2030-01-14 10:00', 'Europe/Paris', 'Asia/Tokyo'), '2030-01-14 18:00');
    assert.equal(convertNaive('2030-07-15 10:00', 'Europe/Paris', 'Asia/Tokyo'), '2030-07-15 17:00');
  });

  it('crosses midnight when the moment does', () => {
    assert.equal(convertNaive('2030-01-14 20:00', 'Europe/Paris', 'Asia/Tokyo'), '2030-01-15 04:00');
    assert.equal(convertNaive('2030-01-14 01:00', 'Europe/Paris', 'America/New_York'), '2030-01-13 19:00');
  });
});

describe('shiftRuleDays', () => {
  it('moves weekdays, keeping ordinals', () => {
    assert.equal(shiftRuleDays('FREQ=WEEKLY;BYDAY=MO,WE,SU', 1), 'FREQ=WEEKLY;BYDAY=TU,TH,MO');
    assert.equal(shiftRuleDays('FREQ=MONTHLY;BYDAY=1MO', -1), 'FREQ=MONTHLY;BYDAY=1SU');
  });

  it('moves month days, and leaves a rule alone when that would leave the month', () => {
    assert.equal(shiftRuleDays('FREQ=MONTHLY;BYMONTHDAY=14', 1), 'FREQ=MONTHLY;BYMONTHDAY=15');
    assert.equal(shiftRuleDays('FREQ=MONTHLY;BYMONTHDAY=31', 1), 'FREQ=MONTHLY;BYMONTHDAY=31');
  });

  it('changes nothing without a day change or a day list', () => {
    assert.equal(shiftRuleDays('FREQ=WEEKLY;BYDAY=MO', 0), 'FREQ=WEEKLY;BYDAY=MO');
    assert.equal(shiftRuleDays('FREQ=DAILY;COUNT=5', 1), 'FREQ=DAILY;COUNT=5');
  });
});
