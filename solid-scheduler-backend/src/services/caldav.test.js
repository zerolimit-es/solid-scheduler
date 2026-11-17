import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettings, buildEventICS, naiveToISO, resourceName, createCaldavSync } from './caldav.js';

const SETTINGS = {
  enabled: true,
  serverUrl: 'https://cloud.example/remote.php/dav/calendars/alice/solidscheduler',
  username: 'alice',
  password: 's3cret',
  bookingSlug: 'alice',
};

const BOOKING = {
  id: 'booking-123',
  title: 'Meeting - Bob & Alice',
  start: '2030-03-04T09:00:00.000Z',
  end: '2030-03-04T09:30:00.000Z',
  attendeeName: 'Bob',
  attendeeEmail: 'bob@example.com',
  notes: 'Agenda: Q1, planning; budget',
  location: 'Video Call',
};

const quietLogger = { log() {}, warn() {}, error() {} };

function recordingFetch(status = 201) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status }); };
  return { fetch, calls };
}

describe('resolveSettings', () => {
  it('is off unless enabled', () => {
    assert.deepEqual(resolveSettings({ ...SETTINGS, enabled: false }), { ok: false, reason: 'disabled' });
  });

  it('requires the booking slug, so other accounts never sync', () => {
    const r = resolveSettings({ ...SETTINGS, bookingSlug: '' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /CALDAV_BOOKING_SLUG/);
  });

  it('rejects bad URLs and credentials in the URL', () => {
    assert.equal(resolveSettings({ ...SETTINGS, serverUrl: 'not a url' }).ok, false);
    assert.equal(resolveSettings({ ...SETTINGS, serverUrl: 'ftp://cloud.example/cal/' }).ok, false);
    assert.equal(resolveSettings({ ...SETTINGS, serverUrl: 'https://u:p@cloud.example/cal/' }).ok, false);
  });

  it('normalises the collection URL and flags plain http', () => {
    const r = resolveSettings(SETTINGS);
    assert.equal(r.ok, true);
    assert.equal(r.settings.collectionUrl, 'https://cloud.example/remote.php/dav/calendars/alice/solidscheduler/');
    assert.equal(r.settings.insecure, false);
    assert.equal(resolveSettings({ ...SETTINGS, serverUrl: 'http://nas.lan/cal/' }).settings.insecure, true);
    assert.equal(resolveSettings({ ...SETTINGS, serverUrl: 'http://localhost:5232/a/cal/' }).settings.insecure, false);
  });
});

describe('buildEventICS', () => {
  const ics = buildEventICS(BOOKING, { now: new Date('2030-01-01T00:00:00Z') });

  it('is a stored calendar object: no METHOD, CRLF line endings', () => {
    assert.doesNotMatch(ics, /METHOD:/);
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.doesNotMatch(ics.replace(/\r\n/g, ''), /\n/);
  });

  it('uses absolute UTC times and a stable UID', () => {
    assert.match(ics, /\r\nUID:booking-123@solidscheduler\r\n/);
    assert.match(ics, /\r\nDTSTART:20300304T090000Z\r\n/);
    assert.match(ics, /\r\nDTEND:20300304T093000Z\r\n/);
  });

  it('escapes text values', () => {
    assert.match(ics.replace(/\r\n /g, ''), /DESCRIPTION:Booked via SolidScheduler\\nAttendee: Bob\\nEmail: bob@example\.com\\nNotes: Agenda: Q1\\, planning\\; budget/);
  });

  it('adds an RRULE for recurring bookings', () => {
    const recurring = buildEventICS({ ...BOOKING, recurrence: { freq: 'WEEKLY', count: 4, byDay: ['MO'] } });
    assert.match(recurring, /\r\nRRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO\r\n/);
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const long = buildEventICS({ ...BOOKING, notes: 'é'.repeat(200) });
    for (const line of long.split('\r\n')) {
      assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${line.length}`);
    }
    assert.ok(long.replace(/\r\n /g, '').includes('é'.repeat(200)));
  });
});

describe('naiveToISO', () => {
  it("converts the organizer's local time to UTC, across DST", () => {
    assert.equal(naiveToISO('2030-01-15 09:30', 'Europe/Paris'), '2030-01-15T08:30:00.000Z');
    assert.equal(naiveToISO('2030-07-15 09:30', 'Europe/Paris'), '2030-07-15T07:30:00.000Z');
  });
});

describe('createCaldavSync', () => {
  it('PUTs the booking to the collection with basic auth, refusing redirects', async () => {
    const { fetch, calls } = recordingFetch();
    const sync = createCaldavSync({ settings: SETTINGS, fetch, logger: quietLogger });
    assert.equal(await sync.putBooking('alice', BOOKING), true);
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://cloud.example/remote.php/dav/calendars/alice/solidscheduler/booking-123.ics');
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers.Authorization, `Basic ${Buffer.from('alice:s3cret').toString('base64')}`);
    assert.equal(init.headers['Content-Type'], 'text/calendar; charset=utf-8');
    assert.equal(init.redirect, 'error');
    assert.match(init.body, /SUMMARY:Meeting - Bob & Alice/);
  });

  it("never sends another account's booking", async () => {
    const { fetch, calls } = recordingFetch();
    const sync = createCaldavSync({ settings: SETTINGS, fetch, logger: quietLogger });
    assert.equal(await sync.bookingCreated('mallory', BOOKING), false);
    assert.equal(await sync.bookingCancelled('mallory', BOOKING.id), false);
    assert.equal(await sync.bookingCreated(undefined, BOOKING), false);
    assert.equal(calls.length, 0);
  });

  it('does nothing when misconfigured', async () => {
    const { fetch, calls } = recordingFetch();
    const sync = createCaldavSync({ settings: { ...SETTINGS, bookingSlug: '' }, fetch, logger: quietLogger });
    assert.equal(sync.enabled, false);
    assert.equal(await sync.bookingCreated('alice', BOOKING), false);
    assert.equal(calls.length, 0);
  });

  it('DELETEs on cancel and treats 404 as already removed', async () => {
    const { fetch, calls } = recordingFetch(404);
    const sync = createCaldavSync({ settings: SETTINGS, fetch, logger: quietLogger });
    assert.equal(await sync.deleteBooking('alice', 'booking-123'), true);
    assert.equal(calls[0].init.method, 'DELETE');
    assert.equal(calls[0].init.body, undefined);
  });

  it('logs failures instead of throwing, so bookings never fail because of CalDAV', async () => {
    const warnings = [];
    const sync = createCaldavSync({
      settings: SETTINGS,
      fetch: async () => { throw new Error('ECONNREFUSED'); },
      logger: { log() {}, warn: (m) => warnings.push(m), error() {} },
      retryDelays: [],
    });
    assert.equal(await sync.bookingCreated('alice', BOOKING), false);
    assert.equal(await sync.bookingCancelled('alice', 'booking-123'), false);
    assert.equal(warnings.length, 2);
    await assert.rejects(sync.putBooking('alice', BOOKING), /ECONNREFUSED/);
  });

  it('keeps resource names URL-safe', () => {
    assert.equal(resourceName('booking-1b2c'), 'booking-1b2c.ics');
    assert.equal(resourceName('../../etc/passwd'), '.._.._etc_passwd.ics');
  });
});

describe('createCaldavSync: retries', () => {
  /** A CalDAV server that answers with the given statuses in turn (an Error is a network failure). */
  function flakyServer(...answers) {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return new Response(null, { status: answer });
    };
    return { fetch, calls };
  }
  const waits = [];
  const options = (fetch) => ({
    settings: SETTINGS, fetch, logger: quietLogger, retryDelays: [10, 20],
    wait: async (ms) => { waits.push(ms); },
  });

  it('tries again after a server error or a network failure, then succeeds', async () => {
    waits.length = 0;
    const { fetch, calls } = flakyServer(503, new Error('ECONNRESET'), 201);
    assert.equal(await createCaldavSync(options(fetch)).bookingCreated('alice', BOOKING), true);
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [10, 20]);
  });

  it('gives up after the last retry', async () => {
    const { fetch, calls } = flakyServer(500);
    assert.equal(await createCaldavSync(options(fetch)).bookingCreated('alice', BOOKING), false);
    assert.equal(calls.length, 3);
  });

  it('does not retry a request the server refuses (wrong password, bad request)', async () => {
    const { fetch, calls } = flakyServer(401);
    assert.equal(await createCaldavSync(options(fetch)).bookingCreated('alice', BOOKING), false);
    assert.equal(calls.length, 1);
  });
});

describe('createCaldavSync: bound to the account, not the link name', () => {
  /** Accounts by booking link, and the remembered binding. */
  function accountsStore(links) {
    const bindings = new Map();
    return {
      links,
      accountForSlug: (slug) => links[slug] ?? null,
      getBinding: (key) => bindings.get(key) ?? null,
      setBinding: (key, id) => bindings.set(key, id),
    };
  }

  it('keeps syncing the same account after it renames its booking link', async () => {
    const { fetch, calls } = recordingFetch();
    const accounts = accountsStore({ alice: 'tenant-alice' });
    const sync = createCaldavSync({ settings: SETTINGS, fetch, logger: quietLogger, accounts });
    assert.equal(await sync.bookingCreated('alice', BOOKING), true);

    // Alice renames her link; Mallory then takes the old one
    delete accounts.links.alice;
    accounts.links['alice-new'] = 'tenant-alice';
    accounts.links.alice = 'tenant-mallory';

    assert.equal(await sync.bookingCreated('alice-new', BOOKING), true, 'the bound account, under its new link');
    assert.equal(await sync.bookingCreated('alice', BOOKING), false, 'the old link now belongs to someone else');
    assert.equal(calls.length, 2);
  });

  it('syncs nothing until an account holds the configured link', async () => {
    const { fetch, calls } = recordingFetch();
    const accounts = accountsStore({ bob: 'tenant-bob' });
    const sync = createCaldavSync({ settings: SETTINGS, fetch, logger: quietLogger, accounts });
    assert.equal(await sync.bookingCreated('alice', BOOKING), false);
    assert.equal(await sync.bookingCreated('bob', BOOKING), false);
    assert.equal(calls.length, 0);
  });

  it('syncs nothing if the account cannot be checked', async () => {
    const { fetch, calls } = recordingFetch();
    const accounts = { accountForSlug: () => { throw new Error('db down'); }, getBinding: () => null, setBinding() {} };
    const sync = createCaldavSync({ settings: SETTINGS, fetch, logger: quietLogger, accounts });
    assert.equal(await sync.bookingCreated('alice', BOOKING), false);
    assert.equal(calls.length, 0);
  });
});

