import nodemailer from 'nodemailer';
import config from '../../config/index.js';
import { escapeICSText } from '../../utils/ics.js';
import { singleLine } from '../../utils/html.js';
import { isValidTimeZone } from '../../utils/tz.js';

/** Escape HTML special characters to prevent XSS in email templates. */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same SMTP settings as the rest of the app (config.email)
const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.secure,
  requireTLS: config.email.requireTLS,
  auth: config.email.user ? { user: config.email.user, pass: config.email.pass } : undefined,
  tls: { rejectUnauthorized: config.nodeEnv === 'production' },
});

const FROM = `"${config.email.fromName}" <${config.email.from}>`;
const ORGANIZER_EMAIL = config.organizer.email;

/** Email colours. */
const COLORS = {
  primary: '#6366F1',
  accent: '#6366F1',
  bg: '#0F172A',
  card: '#1E293B',
  border: 'rgba(142,202,230,0.12)',
  borderSolid: '#143345',
  textPrimary: '#E8F4FA',
  textSecondary: '#C8DFE8',
  textMuted: '#8FAAB8',
  textFooter: '#4A6B7A',
  cancel: '#dc2626',
};

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const FOOTER_TEXT = 'Scheduled with SolidScheduler · Privacy-first scheduling';

export async function sendVisitorConfirmation({ booking, icsContent }) {
  const c = COLORS;
  const { title, date, startTime, endTime, attendee } = booking;
  const notesRow = booking.notes ? `<tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px">Notes</td><td style="color:${c.textSecondary};font-size:13px;padding:14px 20px;text-align:right;line-height:1.4">${escHtml(booking.notes)}</td></tr>` : '';
  const whereBottom = booking.notes ? `border-bottom:1px solid ${c.borderSolid};` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${c.bg};font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      
      <h1 style="color:${c.textPrimary};font-size:22px;font-weight:700;margin:0 0 4px">Meeting Confirmed</h1>
      <p style="color:${c.textMuted};font-size:13px;margin:0">Powered by SolidScheduler</p>
    </div>
    <div style="background:${c.card};border-radius:16px;border:1px solid ${c.border};overflow:hidden">
      <div style="padding:28px 32px">
        <p style="color:${c.textMuted};font-size:14px;margin:0 0 8px">Hi ${escHtml(attendee.name)},</p>
        <p style="color:${c.textSecondary};font-size:14px;margin:0 0 28px;line-height:1.5">Your meeting has been confirmed. Here are the details:</p>
        <div style="background:${c.bg};border:1px solid ${c.border};border-radius:12px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse" cellpadding="0" cellspacing="0">
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};width:80px">What</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};text-align:right;font-weight:600">${escHtml(title)}</td></tr>
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid}">When</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};text-align:right;font-weight:600">${escHtml(date)}</td></tr>
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid}">Time</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};text-align:right;font-weight:600">${escHtml(startTime)} — ${escHtml(endTime)}</td></tr>
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;${whereBottom}">Where</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;text-align:right;font-weight:600;${whereBottom}">Video Call</td></tr>
            ${notesRow}
          </table>
        </div>
      </div>
      <div style="padding:16px 32px 24px;border-top:1px solid ${c.border}">
        <p style="color:${c.textMuted};font-size:13px;margin:0;line-height:1.5">A calendar invite (.ics) is attached. Open it to add this event to your calendar.</p>
      </div>
    </div>
    <div style="text-align:center;margin-top:32px">
      <p style="color:${c.textFooter};font-size:11px;margin:0">${FOOTER_TEXT}</p>
    </div>
  </div>
</body>
</html>`;

  await transporter.sendMail({
    from: FROM,
    // Address-object form: nodemailer encodes the display name, so a
    // crafted attendee name can't inject headers or extra recipients.
    to: { name: attendee.name, address: attendee.email },
    subject: `Meeting Confirmed — ${date} at ${startTime}`,
    html,
    icalEvent: {
      filename: 'meeting.ics',
      method: 'REQUEST',
      content: icsContent,
    },
  });

  console.log(`[Email] ✓ Visitor confirmation sent to ${attendee.email}`);
}

export async function sendOrganizerNotification({ booking, icsContent, organizerEmail }) {
  const recipient = organizerEmail || ORGANIZER_EMAIL;
  if (!recipient) {
    console.log('[Email] ⚠ No ORGANIZER_EMAIL set, skipping organizer notification');
    return;
  }

  const c = COLORS;
  const { date, startTime, endTime, attendee } = booking;
  const notesRow = booking.notes ? `<tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px">Notes</td><td style="color:${c.textSecondary};font-size:13px;padding:14px 20px;text-align:right;line-height:1.4">${escHtml(booking.notes)}</td></tr>` : '';
  const whereBottom = booking.notes ? `border-bottom:1px solid ${c.borderSolid};` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${c.bg};font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      
      <h1 style="color:${c.textPrimary};font-size:22px;font-weight:700;margin:0 0 4px">New Booking</h1>
      <p style="color:${c.textMuted};font-size:13px;margin:0">Someone just booked a meeting with you</p>
    </div>
    <div style="background:${c.card};border-radius:16px;border:1px solid ${c.border};overflow:hidden">
      <div style="padding:28px 32px">
        <div style="background:${c.bg};border:1px solid ${c.border};border-radius:12px;overflow:hidden;margin-bottom:20px">
          <table style="width:100%;border-collapse:collapse" cellpadding="0" cellspacing="0">
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};width:80px">Who</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};text-align:right;font-weight:600">${escHtml(attendee.name)}</td></tr>
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid}">Email</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};text-align:right;font-weight:600"><a href="mailto:${escHtml(attendee.email)}" style="color:${c.primary};text-decoration:none">${escHtml(attendee.email)}</a></td></tr>
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid}">When</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};text-align:right;font-weight:600">${escHtml(date)}</td></tr>
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid}">Time</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};text-align:right;font-weight:600">${escHtml(startTime)} — ${escHtml(endTime)}</td></tr>
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;${whereBottom}">Where</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;text-align:right;font-weight:600;${whereBottom}">Video Call</td></tr>
            ${notesRow}
          </table>
        </div>
        <p style="color:${c.textMuted};font-size:13px;margin:0;line-height:1.5">Calendar invite attached — open to add to your calendar.</p>
      </div>
      <div style="padding:16px 32px 24px;border-top:1px solid ${c.border};text-align:center">
        <a href="${FRONTEND_URL}" style="display:inline-block;padding:10px 28px;background:${c.primary};color:white;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600">Open Dashboard →</a>
      </div>
    </div>
    <div style="text-align:center;margin-top:32px">
      <p style="color:${c.textFooter};font-size:11px;margin:0">${FOOTER_TEXT}</p>
    </div>
  </div>
</body>
</html>`;

  await transporter.sendMail({
    from: FROM,
    to: recipient,
    subject: `New Booking — ${attendee.name} on ${date} at ${startTime}`,
    html,
    icalEvent: {
      filename: 'meeting.ics',
      method: 'REQUEST',
      content: icsContent,
    },
  });

  console.log(`[Email] ✓ Organizer notification sent to ${recipient}`);
}

export async function sendCancellationNotice(booking, options = {}) {
  const cancelledBy = options.cancelledBy || 'the organizer';
  const c = COLORS;

  // In the account's timezone, not the server's
  const formatDateTime = (date) =>
    new Date(date).toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long',
      day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: isValidTimeZone(options.timezone) ? options.timezone : 'UTC',
      timeZoneName: 'short',
    });

  const startDisplay = formatDateTime(booking.start);

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SolidScheduler//EN',
    'METHOD:CANCEL',
    'BEGIN:VEVENT',
    `UID:${booking.id}@solidscheduler.local`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    `DTSTART:${new Date(booking.start).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    `DTEND:${new Date(booking.end).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    `SUMMARY:Cancelled: ${escapeICSText(booking.title)}`,
    'STATUS:CANCELLED',
    'SEQUENCE:2',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${c.bg};font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      
      <h1 style="color:${c.textPrimary};font-size:22px;font-weight:700;margin:0 0 4px">Meeting Cancelled</h1>
      <p style="color:${c.textMuted};font-size:13px;margin:0">Cancelled by ${escHtml(cancelledBy)}</p>
    </div>
    <div style="background:${c.card};border-radius:16px;border:1px solid ${c.border};overflow:hidden">
      <div style="padding:28px 32px">
        <div style="background:${c.bg};border:1px solid ${c.border};border-radius:12px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse" cellpadding="0" cellspacing="0">
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};width:80px">What</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};text-align:right;font-weight:600;text-decoration:line-through">${escHtml(booking.title)}</td></tr>
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid}">Was</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;border-bottom:1px solid ${c.borderSolid};text-align:right;font-weight:600;text-decoration:line-through">${escHtml(startDisplay)}</td></tr>
            <tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px">Where</td><td style="color:${c.textPrimary};font-size:13px;padding:14px 20px;text-align:right;font-weight:600;text-decoration:line-through">${escHtml(booking.location || 'Video Call')}</td></tr>
          </table>
        </div>
      </div>
      <div style="padding:16px 32px 24px;border-top:1px solid ${c.border}">
        <p style="color:${c.textMuted};font-size:13px;margin:0;line-height:1.5">A calendar cancellation is attached to update your calendar.</p>
      </div>
    </div>
    <div style="text-align:center;margin-top:32px">
      <p style="color:${c.textFooter};font-size:11px;margin:0">${FOOTER_TEXT}</p>
    </div>
  </div>
</body>
</html>`;

  const mailOptions = {
    from: FROM,
    subject: singleLine(`Cancelled: ${booking.title}`),
    html,
    icalEvent: {
      filename: 'cancelled.ics',
      method: 'CANCEL',
      content: icsLines,
    },
  };

  const results = { attendee: null, organizer: null, errors: [] };

  if (booking.attendee?.email) {
    try {
      results.attendee = await transporter.sendMail({
        ...mailOptions,
        to: { name: booking.attendee.name, address: booking.attendee.email },
      });
      console.log(`[Email] ✓ Cancellation sent to attendee: ${booking.attendee.email}`);
    } catch (err) {
      console.error(`[Email] ✗ Cancellation to attendee failed:`, err.message);
      results.errors.push({ recipient: 'attendee', error: err.message });
    }
  }

  if (!options.skipOrganizer) {
    const orgEmail = booking.organizer?.email || ORGANIZER_EMAIL;
    if (orgEmail) {
      try {
        results.organizer = await transporter.sendMail({
          ...mailOptions,
          to: orgEmail,
        });
        console.log(`[Email] ✓ Cancellation sent to organizer: ${orgEmail}`);
      } catch (err) {
        console.error(`[Email] ✗ Cancellation to organizer failed:`, err.message);
        results.errors.push({ recipient: 'organizer', error: err.message });
      }
    }
  }

  return results;
}

export async function verifySmtp() {
  try {
    await transporter.verify();
    console.log('[Email] ✓ SMTP connection verified');
    return true;
  } catch (err) {
    console.error('[Email] ✗ SMTP connection failed:', err.message);
    return false;
  }
}
