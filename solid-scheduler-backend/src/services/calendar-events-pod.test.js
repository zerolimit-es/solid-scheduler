/**
 * Blocked time read from the Pod: read several resources at a time, and on
 * import, entries with a repeat rule the app can't use are left out.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solid-scheduler-cal-pod-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
delete process.env.DB_ENCRYPTION_KEY;

const POD = 'https://pod.example/alice/';
const CONTAINER = `${POD}solid-scheduler/calendar-events/`;

let solid;
let importPodEventsToSQLite;
let getCalendarEvent;

/** A fake Pod holding `events`; records how many reads run at once. */
function fakePod(events) {
  const state = { inFlight: 0, maxInFlight: 0 };
  state.fetch = async (input) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const turtle = (body) => {
      const res = new Response(body, { headers: { 'Content-Type': 'text/turtle' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    };
    if (url === CONTAINER) {
      return turtle(events.map((e) => `<${CONTAINER}> <http://www.w3.org/ns/ldp#contains> <${CONTAINER}${e.id}.ttl> .`).join('\n'));
    }
    const event = events.find((e) => url === `${CONTAINER}${e.id}.ttl`);
    if (!event) return new Response('Not found', { status: 404 });
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.inFlight--;
    const rule = event.rule ? `<${url}#event> <${solid.SCHED_RRULE}> "${event.rule}" .\n` : '';
    const S = solid.SCHEMA;
    return turtle(`<${url}#event> <${S.name}Type> <${solid.CAL_TYPE}> ;
      <${S.identifier}> "${event.id}" ;
      <${S.name}> "Blocked ${event.id}" ;
      <${S.startDate}> "2030-09-16T08:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
      <${S.endDate}> "2030-09-16T09:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> .
${rule}`);
  };
  return state;
}

before(async () => {
  const mod = await import('./solid.js');
  const { SCHED, SCHEMA } = await import('@zerolimit/packages/solid-pod-sync/core');
  solid = {
    SCHEMA,
    loadCalendarEvents: mod.loadCalendarEvents,
    CAL_TYPE: SCHED.Booking.replace('Booking', 'CalendarEvent'),
    SCHED_RRULE: SCHED.rruleString,
  };
  ({ importPodEventsToSQLite } = await import('../cloud/services/pod-sync.js'));
  ({ getCalendarEvent } = await import('../cloud/models/calendar-events-db.js'));
  const { getDb } = await import('../cloud/models/database.js');
  getDb().prepare("INSERT INTO tenants (id, email) VALUES ('t1', 'alice@example.com')").run();
});

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('blocked time from the Pod', () => {
  it('reads every entry, several at a time', async () => {
    const pod = fakePod(Array.from({ length: 20 }, (_, i) => ({ id: `e${i}` })));
    const events = await solid.loadCalendarEvents(POD, pod.fetch);
    assert.equal(events.length, 20);
    assert.deepEqual(events.map((e) => e.id), Array.from({ length: 20 }, (_, i) => `e${i}`), 'in the listing order');
    assert.ok(pod.maxInFlight > 1, 'reads overlap');
    assert.ok(pod.maxInFlight <= 8, 'at most 8 at once');
  });

  it('leaves out an entry whose repeat rule the app cannot use when importing', async () => {
    const pod = fakePod([
      { id: 'weekly', rule: 'FREQ=WEEKLY;BYDAY=MO' },
      { id: 'broken', rule: 'BYDAY=MO' },
    ]);
    await importPodEventsToSQLite(POD, pod.fetch, 't1', 'Europe/Paris');
    assert.equal(getCalendarEvent('t1', 'weekly')?.recurrence, 'FREQ=WEEKLY;BYDAY=MO');
    assert.equal(getCalendarEvent('t1', 'broken'), null);
  });
});
