/**
 * Keeping the local bookings table and the Pod in step:
 * bookings written straight to the Pod are recorded locally, and bookings
 * cancelled locally after syncing are cancelled in the Pod.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-booking-sync-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DB_ENCRYPTION_KEY;

const POD = 'https://pod.example/alice/';
const BOOKING_URL = `${POD}solid-scheduler/bookings/booking-1.ttl`;
let bookings, sync, db;

/** A stand-in Pod: serves one booking resource and records every write to it. */
function fakePod() {
  const writes = [];
  const turtle = `
    <${BOOKING_URL}#event>
      <http://schema.org/nameType> <https://vocab.protonscheduler.app/ns#Booking> ;
      <http://schema.org/eventStatus> <http://schema.org/EventConfirmed> .`;
  const fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || (typeof input === 'string' ? 'GET' : input.method) || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      const res = new Response(turtle, { status: 200, headers: { 'Content-Type': 'text/turtle' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }
    writes.push({ method, url, body: String(init.body ?? '') });
    const res = new Response(null, { status: 205 });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  return { fetch, writes };
}

before(async () => {
  db = (await import('../cloud/models/database.js'));
  bookings = await import('../cloud/models/bookings-db.js');
  sync = await import('../cloud/services/pod-sync.js');
  bookings.initBookingsTable();
});

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bookings written straight to the Pod are recorded locally', () => {
  const record = (over = {}) => bookings.recordPodBooking({
    id: 'booking-1', slug: 'alice', title: 'Meeting with Bo',
    start: '2030-09-16 09:30', end: '2030-09-16 10:00',
    attendeeName: 'Bo', attendeeEmail: 'bo@example.com', podUrl: BOOKING_URL, ...over,
  });

  it('stores the booking as already synced, once', () => {
    assert.equal(record(), true);
    assert.equal(record(), false, 'same ID is not inserted twice');
    const row = bookings.getBookingById('booking-1');
    assert.equal(row.synced_to_pod, 1);
    assert.equal(row.pod_url, BOOKING_URL);
    assert.equal(row.status, 'confirmed');
    assert.deepEqual(bookings.getUnsyncedBookings('alice'), [], 'not pushed to the Pod again');
  });

  it('makes the time count as taken on that page only', () => {
    assert.equal(bookings.hasOverlappingBooking('alice', '2030-09-16 09:30', '2030-09-16 10:00'), true);
    assert.equal(bookings.hasOverlappingBooking('alice', '2030-09-16 09:00', '2030-09-16 09:45'), true, 'partial overlap');
    assert.equal(bookings.hasOverlappingBooking('alice', '2030-09-16 09:00', '2030-09-16 09:30'), false, 'ends as it starts');
    assert.equal(bookings.hasOverlappingBooking('alice', '2030-09-16 10:00', '2030-09-16 10:30'), false, 'starts as it ends');
    assert.equal(bookings.hasOverlappingBooking('bob', '2030-09-16 09:30', '2030-09-16 10:00'), false);
    assert.equal(bookings.getBookedSlots('alice', '2030-09-16').length, 1);
  });
});

describe('cancelling', () => {
  it("only cancels a booking through its own page's slug", () => {
    assert.equal(bookings.cancelBookingForSlug('booking-1', 'bob'), false);
    assert.equal(bookings.getBookingById('booking-1').status, 'confirmed');
    assert.equal(bookings.cancelBookingForSlug('booking-1', 'alice'), true);
    assert.equal(bookings.getBookingById('booking-1').status, 'cancelled');
    assert.equal(bookings.hasOverlappingBooking('alice', '2030-09-16 09:30', '2030-09-16 10:00'), false, 'slot is free again');
  });

  it('leaves the Pod copy pending when the Pod cannot be reached, and retries later', async () => {
    bookings.markPodCancelPending('booking-1');
    const failing = async () => { throw new Error('offline'); };
    assert.deepEqual(await sync.syncCancellationsToPod(POD, failing, 'alice'), { cancelled: 0, failed: 1, total: 1 });
    assert.equal(bookings.getPendingPodCancellations('alice').length, 1);

    const pod = fakePod();
    assert.deepEqual(await sync.syncCancellationsToPod(POD, pod.fetch, 'alice'), { cancelled: 1, failed: 0, total: 1 });
    assert.equal(pod.writes.length, 1);
    assert.equal(pod.writes[0].url, BOOKING_URL);
    assert.match(pod.writes[0].body, /EventCancelled/);
    assert.deepEqual(bookings.getPendingPodCancellations('alice'), []);

    // Nothing left to do on the next sync
    assert.deepEqual(await sync.syncCancellationsToPod(POD, pod.fetch, 'alice'), { cancelled: 0, failed: 0, total: 0 });
    assert.equal(pod.writes.length, 1);
  });

  it("never writes to a resource outside the owner's Pod, or for another page", async () => {
    bookings.markPodCancelPending('booking-1');
    const pod = fakePod();
    const elsewhere = await sync.syncCancellationsToPod('https://pod.example/mallory/', pod.fetch, 'alice');
    assert.deepEqual(elsewhere, { cancelled: 0, failed: 1, total: 1 });
    assert.deepEqual(await sync.syncCancellationsToPod(POD, pod.fetch, 'bob'), { cancelled: 0, failed: 0, total: 0 });
    assert.equal(pod.writes.length, 0);
  });
});
