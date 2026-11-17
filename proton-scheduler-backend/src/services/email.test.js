/**
 * The dashboard's own emails (confirmation, cancellation): user-supplied
 * text must not become HTML, and times are shown in the account's timezone.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';

const sent = [];
let email, cloudEmail;

before(async () => {
  // Capture mail instead of sending it
  nodemailer.createTransport = () => ({
    sendMail: async (message) => { sent.push(message); return { messageId: 'test' }; },
    verify: async () => true,
  });
  email = await import('./email.js');
  cloudEmail = await import('../cloud/services/email.js');
});

beforeEach(() => { sent.length = 0; });

const booking = (over = {}) => ({
  id: 'booking-1',
  title: 'Meeting with <b>Eve</b>',
  start: new Date('2030-07-15T08:00:00Z'), // 10:00 in Paris
  end: new Date('2030-07-15T08:30:00Z'),
  location: 'Room "A" & <i>B</i>',
  notes: '<img src=x onerror=alert(1)> see https://evil.example',
  organizer: { name: 'Olga <script>', email: 'olga@example.com' },
  attendee: { name: 'Eve <a href="https://evil.example">click</a>', email: 'eve@example.com' },
  timezone: 'Europe/Paris',
  ...over,
});

const htmlOf = (message) => String(message.html);

describe('confirmation emails', () => {
  it('escape names, titles, locations and notes in the HTML', async () => {
    await email.sendBookingConfirmation(booking());
    assert.equal(sent.length, 2, 'attendee and organizer');
    for (const message of sent) {
      const html = htmlOf(message);
      assert.ok(!/<script>|<img |<a href="https:\/\/evil|<b>Eve<\/b>|<i>B<\/i>/.test(html), 'no injected markup');
      assert.match(html, /Meeting with &lt;b&gt;Eve&lt;\/b&gt;/);
      assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    }
    assert.match(htmlOf(sent[0]), /Olga &lt;script&gt;/);
    assert.match(htmlOf(sent[1]), /Eve &lt;a href=&quot;https:\/\/evil\.example&quot;&gt;click&lt;\/a&gt;/);
  });

  it("show the time in the account's timezone, in HTML and plain text", async () => {
    await email.sendBookingConfirmation(booking());
    assert.match(htmlOf(sent[0]), /10:00 AM/);
    assert.match(sent[0].text, /10:00 AM/);
    assert.match(sent[0].text, /GMT\+2|CEST/);
  });

  it('keep the subject on one line', async () => {
    await email.sendBookingConfirmation(booking({ title: 'Sync\r\nBcc: x@example.com' }));
    assert.ok(!/[\r\n]/.test(sent[0].subject), sent[0].subject);
  });
});

describe('cancellation emails', () => {
  it('escape user text and use the timezone the caller passes', async () => {
    await email.sendCancellationNotice(booking({ timezone: undefined }),
      { reason: '<b>busy</b>', cancelledBy: 'the organizer', timezone: 'Europe/Paris' });
    assert.ok(sent.length >= 1);
    const html = htmlOf(sent[0]);
    assert.ok(!/<b>busy<\/b>|<b>Eve<\/b>/.test(html));
    assert.match(html, /10:00 AM/);
  });

  it('fall back to UTC, never the server timezone, when none is known', async () => {
    await email.sendCancellationNotice(booking({ timezone: undefined }), {});
    assert.match(htmlOf(sent[0]), /8:00 AM/);
  });

  it('(branded) show the account timezone and escape the title in the calendar attachment', async () => {
    await cloudEmail.sendCancellationNotice(booking({ title: 'Sync; plan, review' }), { timezone: 'Europe/Paris' });
    assert.ok(sent.length >= 1);
    assert.match(htmlOf(sent[0]), /10:00 AM/);
    assert.ok(sent[0].icalEvent.content.includes('SUMMARY:Cancelled: Sync\\; plan\\, review'), sent[0].icalEvent.content);
  });
});
