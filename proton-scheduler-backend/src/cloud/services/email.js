import nodemailer from 'nodemailer';

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

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.tem.scaleway.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = `"${process.env.SMTP_FROM_NAME || 'ProtonScheduler'}" <${process.env.SMTP_FROM || 'noreply@localhost'}>`;
const ORGANIZER_EMAIL = process.env.ORGANIZER_EMAIL || '';

/** ProtonScheduler defaults — used when tenant has no custom branding. */
const PROTON = {
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

/** Resolve tenant branding to email-safe colors with ProtonScheduler fallbacks. */
function resolveColors(branding) {
  if (!branding) return PROTON;
  return {
    primary: branding.primary_color || PROTON.primary,
    accent: branding.accent_color || PROTON.accent,
    bg: branding.background_color || PROTON.bg,
    card: branding.background_color ? lightenHex(branding.background_color, 0.06) : PROTON.card,
    border: branding.background_color ? lightenHex(branding.background_color, 0.12) : PROTON.borderSolid,
    borderSolid: branding.background_color ? lightenHex(branding.background_color, 0.12) : PROTON.borderSolid,
    textPrimary: branding.text_color || PROTON.textPrimary,
    textSecondary: branding.text_color ? fadeHex(branding.text_color, 0.85) : PROTON.textSecondary,
    textMuted: branding.text_color ? fadeHex(branding.text_color, 0.6) : PROTON.textMuted,
    textFooter: branding.text_color ? fadeHex(branding.text_color, 0.4) : PROTON.textFooter,
    cancel: PROTON.cancel,
    companyName: branding.company_name || null,
    logoUrl: branding.logo_url || null,
    hideBadge: !!branding.hide_proton_badge,
  };
}

/** Lighten a hex color by mixing with white. factor 0-1, 0=original, 1=white. */
function lightenHex(hex, factor) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * factor);
  const lg = Math.round(g + (255 - g) * factor);
  const lb = Math.round(b + (255 - b) * factor);
  return `#${lr.toString(16).padStart(2,'0')}${lg.toString(16).padStart(2,'0')}${lb.toString(16).padStart(2,'0')}`;
}

/** Fade a hex color toward gray. Returns a hex string at the given intensity. */
function fadeHex(hex, intensity) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mid = 128;
  const fr = Math.round(mid + (r - mid) * intensity);
  const fg = Math.round(mid + (g - mid) * intensity);
  const fb = Math.round(mid + (b - mid) * intensity);
  return `#${fr.toString(16).padStart(2,'0')}${fg.toString(16).padStart(2,'0')}${fb.toString(16).padStart(2,'0')}`;
}

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/** Render the email header icon — tenant logo or nothing. */
function headerIcon(c) {
  // If user has their own logo, always show it
  if (c.logoUrl) {
    const alt = c.companyName || 'Logo';
    return `<img src="${escHtml(c.logoUrl)}" alt="${escHtml(alt)}" width="56" height="56" style="display:block;margin:0 auto 16px;width:56px;height:56px;border-radius:16px;object-fit:cover" />`;
  }
  return '';
}

function footerText(c) {
  if (c.hideBadge && c.companyName) return `Scheduled with ${escHtml(c.companyName)}`;
  if (c.companyName) return `Scheduled with ${escHtml(c.companyName)} · Powered by ProtonScheduler`;
  return 'Scheduled with ProtonScheduler · Privacy-first scheduling';
}

export async function sendVisitorConfirmation({ booking, icsContent, branding }) {
  const c = resolveColors(branding);
  const { title, date, startTime, endTime, attendee } = booking;
  const notesRow = booking.notes ? `<tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px">Notes</td><td style="color:${c.textSecondary};font-size:13px;padding:14px 20px;text-align:right;line-height:1.4">${escHtml(booking.notes)}</td></tr>` : '';
  const whereBottom = booking.notes ? `border-bottom:1px solid ${c.borderSolid};` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${c.bg};font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      ${headerIcon(c)}
      <h1 style="color:${c.textPrimary};font-size:22px;font-weight:700;margin:0 0 4px">Meeting Confirmed</h1>
      <p style="color:${c.textMuted};font-size:13px;margin:0">${c.companyName ? escHtml(c.companyName) : 'Powered by ProtonScheduler'}</p>
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
      <p style="color:${c.textFooter};font-size:11px;margin:0">${footerText(c)}</p>
    </div>
  </div>
</body>
</html>`;

  await transporter.sendMail({
    from: FROM,
    to: `"${attendee.name}" <${attendee.email}>`,
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

export async function sendOrganizerNotification({ booking, icsContent, organizerEmail, branding }) {
  const recipient = organizerEmail || ORGANIZER_EMAIL;
  if (!recipient) {
    console.log('[Email] ⚠ No ORGANIZER_EMAIL set, skipping organizer notification');
    return;
  }

  const c = resolveColors(branding);
  const { title, date, startTime, endTime, attendee } = booking;
  const notesRow = booking.notes ? `<tr><td style="color:${c.textMuted};font-size:13px;padding:14px 20px">Notes</td><td style="color:${c.textSecondary};font-size:13px;padding:14px 20px;text-align:right;line-height:1.4">${escHtml(booking.notes)}</td></tr>` : '';
  const whereBottom = booking.notes ? `border-bottom:1px solid ${c.borderSolid};` : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${c.bg};font-family:-apple-system,'Helvetica Neue',Arial,sans-serif;-webkit-font-smoothing:antialiased">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px">
    <div style="text-align:center;margin-bottom:32px">
      ${headerIcon(c)}
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
      <p style="color:${c.textFooter};font-size:11px;margin:0">${footerText(c)}</p>
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
  const c = resolveColors(options.branding || null);

  const formatDateTime = (date) =>
    new Date(date).toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long',
      day: 'numeric', hour: 'numeric', minute: '2-digit',
    });

  const startDisplay = formatDateTime(booking.start);

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ProtonScheduler//EN',
    'METHOD:CANCEL',
    'BEGIN:VEVENT',
    `UID:${booking.id}@protonscheduler.local`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    `DTSTART:${new Date(booking.start).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    `DTEND:${new Date(booking.end).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    `SUMMARY:Cancelled: ${booking.title}`,
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
      ${headerIcon(c)}
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
      <p style="color:${c.textFooter};font-size:11px;margin:0">${footerText(c)}</p>
    </div>
  </div>
</body>
</html>`;

  const mailOptions = {
    from: FROM,
    subject: `Cancelled: ${booking.title}`,
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
        to: `"${booking.attendee.name}" <${booking.attendee.email}>`,
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
    console.log('[Email] ✓ SMTP connection verified (Scaleway TEM)');
    return true;
  } catch (err) {
    console.error('[Email] ✗ SMTP connection failed:', err.message);
    return false;
  }
}
