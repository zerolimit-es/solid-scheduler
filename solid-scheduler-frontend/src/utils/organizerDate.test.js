import { describe, it, expect, vi } from 'vitest';
import { organizerToday } from './organizerDate';

describe('organizerToday', () => {
  it("gives the organizer's date, not the visitor's", () => {
    vi.useFakeTimers();
    // 20:00 UTC: already the next day in Tokyo, still the same day in Los Angeles
    vi.setSystemTime(new Date('2030-09-16T20:00:00Z'));
    const tokyo = organizerToday('Asia/Tokyo');
    const losAngeles = organizerToday('America/Los_Angeles');
    expect([tokyo.getFullYear(), tokyo.getMonth(), tokyo.getDate()]).toEqual([2030, 8, 17]);
    expect([losAngeles.getFullYear(), losAngeles.getMonth(), losAngeles.getDate()]).toEqual([2030, 8, 16]);
  });

  it('is a local midnight, so it compares with calendar days', () => {
    const today = organizerToday('Europe/Paris');
    expect([today.getHours(), today.getMinutes(), today.getSeconds()]).toEqual([0, 0, 0]);
  });

  it("falls back to the browser's timezone for a missing or unknown one", () => {
    expect(organizerToday(undefined)).toBeInstanceOf(Date);
    expect(Number.isNaN(organizerToday('Not/AZone').getTime())).toBe(false);
  });
});
