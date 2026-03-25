/**
 * Email Notification Service
 * 
 * Sends booking confirmations and notifications via SMTP.
 * Designed to work with Proton Mail Bridge for end-to-end encrypted email.
 * 
 * Setup for Proton Bridge:
 * 1. Install Proton Bridge: https://proton.me/mail/bridge
 * 2. Log in with your Proton account
 * 3. Use the SMTP settings provided by Bridge (usually localhost:1025)
 * 4. Configure .env with your Bridge credentials
 */

import nodemailer from 'nodemailer';
import config from '../config/index.js';
import { generateICS, generateCancellationICS } from '../utils/ics.js';

// Create reusable transporter
let transporter = null;

/**
 * Initialize the email transporter
 * @returns {Object} Nodemailer transporter
 */
function getTransporter() {
  if (transporter) return transporter;
  
  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: config.email.user ? {
      user: config.email.user,
      pass: config.email.pass,
    } : undefined,
    // For Proton Bridge, we may need to ignore self-signed certs in dev
    tls: {
      rejectUnauthorized: config.nodeEnv === 'production',
    },
  });
  
  return transporter;
}

/**
 * Verify email configuration is working
 * @returns {Promise<boolean>}
 */
export async function verifyEmailConfig() {
  try {
    await getTransporter().verify();
    console.log('✓ Email configuration verified');
    return true;
  } catch (error) {
    console.warn('✗ Email configuration failed:', error.message);
    return false;
  }
}

/**
 * Send a booking confirmation email to both organizer and attendee
 * @param {Object} booking - Booking data
 * @param {Object} options - Additional options
 */
export async function sendBookingConfirmation(booking, options = {}) {
  const transport = getTransporter();
  
  const icsContent = generateICS({
    title: booking.title,
    start: new Date(booking.start),
    end: new Date(booking.end),
    description: booking.description || booking.notes,
    location: booking.location || 'Video Call',
    organizer: booking.organizer,
    attendee: booking.attendee,
    uid: booking.id,
    timezone: booking.timezone,
  });
  
  const formatDateTime = (date) => {
    return new Date(date).toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  };
  
  // Email to attendee
  const attendeeEmail = {
    from: `"ProtonScheduler" <${config.email.from}>`,
    to: booking.attendee.email,
    subject: `Confirmed: ${booking.title} with ${booking.organizer.name}`,
    text: `
Your meeting has been confirmed!

Meeting: ${booking.title}
With: ${booking.organizer.name}
When: ${formatDateTime(booking.start)} - ${formatDateTime(booking.end)}
${booking.location ? `Where: ${booking.location}` : ''}
${booking.notes ? `\nNotes: ${booking.notes}` : ''}

Add this event to your calendar by opening the attached .ics file.

---
Scheduled with ProtonScheduler - Privacy-first scheduling
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #219EBC; color: white; padding: 30px; border-radius: 12px 12px 0 0; }
    .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px; }
    .detail-row { display: flex; padding: 12px 0; border-bottom: 1px solid #e9ecef; }
    .detail-label { color: #6c757d; width: 100px; }
    .detail-value { color: #212529; font-weight: 500; }
    .cta { display: inline-block; background: #219EBC; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin-top: 20px; }
    .footer { text-align: center; padding: 20px; color: #6c757d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 24px;">✓ Meeting Confirmed</h1>
      <p style="margin: 10px 0 0 0; opacity: 0.9;">${booking.title}</p>
    </div>
    <div class="content">
      <div class="detail-row">
        <span class="detail-label">With</span>
        <span class="detail-value">${booking.organizer.name}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">When</span>
        <span class="detail-value">${formatDateTime(booking.start)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Duration</span>
        <span class="detail-value">${Math.round((new Date(booking.end) - new Date(booking.start)) / 60000)} minutes</span>
      </div>
      ${booking.location ? `
      <div class="detail-row">
        <span class="detail-label">Location</span>
        <span class="detail-value">${booking.location}</span>
      </div>
      ` : ''}
      ${booking.notes ? `
      <div class="detail-row">
        <span class="detail-label">Notes</span>
        <span class="detail-value">${booking.notes}</span>
      </div>
      ` : ''}
      <p style="margin-top: 20px;">
        <strong>📎 Calendar Invite Attached</strong><br>
        Open the attached .ics file to add this event to your calendar app.
      </p>
    </div>
    <div class="footer">
      <p>🛡️ Scheduled with ProtonScheduler · Privacy-first scheduling</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
    attachments: [{
      filename: `${booking.title.replace(/[^a-z0-9]/gi, '-')}.ics`,
      content: icsContent,
      contentType: 'text/calendar; method=REQUEST',
    }],
    // For calendar invites, also include as alternative
    alternatives: [{
      contentType: 'text/calendar; method=REQUEST',
      content: icsContent,
    }],
  };
  
  // Email to organizer
  const organizerEmail = {
    from: `"ProtonScheduler" <${config.email.from}>`,
    to: booking.organizer.email,
    subject: `New Booking: ${booking.title} with ${booking.attendee.name}`,
    text: `
You have a new booking!

Meeting: ${booking.title}
With: ${booking.attendee.name} (${booking.attendee.email})
When: ${formatDateTime(booking.start)} - ${formatDateTime(booking.end)}
${booking.location ? `Where: ${booking.location}` : ''}
${booking.notes ? `\nAttendee Notes: ${booking.notes}` : ''}

The attendee has been sent a confirmation email.

---
Scheduled with ProtonScheduler - Privacy-first scheduling
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #219EBC; color: white; padding: 30px; border-radius: 12px 12px 0 0; }
    .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px; }
    .detail-row { display: flex; padding: 12px 0; border-bottom: 1px solid #e9ecef; }
    .detail-label { color: #6c757d; width: 100px; }
    .detail-value { color: #212529; font-weight: 500; }
    .footer { text-align: center; padding: 20px; color: #6c757d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 24px;">📅 New Booking</h1>
      <p style="margin: 10px 0 0 0; opacity: 0.9;">${booking.title}</p>
    </div>
    <div class="content">
      <div class="detail-row">
        <span class="detail-label">Attendee</span>
        <span class="detail-value">${booking.attendee.name}<br><small>${booking.attendee.email}</small></span>
      </div>
      <div class="detail-row">
        <span class="detail-label">When</span>
        <span class="detail-value">${formatDateTime(booking.start)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Duration</span>
        <span class="detail-value">${Math.round((new Date(booking.end) - new Date(booking.start)) / 60000)} minutes</span>
      </div>
      ${booking.notes ? `
      <div class="detail-row">
        <span class="detail-label">Notes</span>
        <span class="detail-value">${booking.notes}</span>
      </div>
      ` : ''}
      <p style="margin-top: 20px; color: #6c757d;">
        ✓ A confirmation email with calendar invite has been sent to ${booking.attendee.email}
      </p>
    </div>
    <div class="footer">
      <p>🛡️ Scheduled with ProtonScheduler · Privacy-first scheduling</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
    attachments: [{
      filename: `${booking.title.replace(/[^a-z0-9]/gi, '-')}.ics`,
      content: icsContent,
      contentType: 'text/calendar; method=REQUEST',
    }],
  };
  
  const results = {
    attendee: null,
    organizer: null,
    errors: [],
  };
  
  // Send to attendee
  try {
    results.attendee = await transport.sendMail(attendeeEmail);
    console.log(`✓ Confirmation sent to attendee: ${booking.attendee.email}`);
  } catch (error) {
    console.error(`✗ Failed to send to attendee:`, error.message);
    results.errors.push({ recipient: 'attendee', error: error.message });
  }
  
  // Send to organizer
  if (!options.skipOrganizer) {
    try {
      results.organizer = await transport.sendMail(organizerEmail);
      console.log(`✓ Notification sent to organizer: ${booking.organizer.email}`);
    } catch (error) {
      console.error(`✗ Failed to send to organizer:`, error.message);
      results.errors.push({ recipient: 'organizer', error: error.message });
    }
  }
  
  return results;
}

/**
 * Send a cancellation email
 * @param {Object} booking - Original booking data
 * @param {Object} options - Additional options
 */
export async function sendCancellationNotice(booking, options = {}) {
  const transport = getTransporter();
  
  const icsContent = generateCancellationICS({
    title: booking.title,
    start: new Date(booking.start),
    end: new Date(booking.end),
    description: booking.description || booking.notes,
    location: booking.location,
    organizer: booking.organizer,
    attendee: booking.attendee,
    uid: booking.id,
    sequence: 1,
    timezone: booking.timezone,
  });
  
  const formatDateTime = (date) => {
    return new Date(date).toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };
  
  const cancellationReason = options.reason || 'This meeting has been cancelled.';
  const cancelledBy = options.cancelledBy || 'the organizer';
  
  const emailContent = {
    from: `"ProtonScheduler" <${config.email.from}>`,
    subject: `Cancelled: ${booking.title}`,
    text: `
Meeting Cancelled

The following meeting has been cancelled by ${cancelledBy}:

Meeting: ${booking.title}
Originally scheduled: ${formatDateTime(booking.start)}

${cancellationReason}

---
ProtonScheduler - Privacy-first scheduling
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #dc3545; color: white; padding: 30px; border-radius: 12px 12px 0 0; }
    .content { background: #f8f9fa; padding: 30px; border-radius: 0 0 12px 12px; }
    .detail-row { display: flex; padding: 12px 0; border-bottom: 1px solid #e9ecef; }
    .detail-label { color: #6c757d; width: 100px; }
    .detail-value { color: #212529; font-weight: 500; text-decoration: line-through; }
    .footer { text-align: center; padding: 20px; color: #6c757d; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 style="margin: 0; font-size: 24px;">✗ Meeting Cancelled</h1>
      <p style="margin: 10px 0 0 0; opacity: 0.9;">${booking.title}</p>
    </div>
    <div class="content">
      <p>This meeting has been cancelled by ${cancelledBy}.</p>
      <div class="detail-row">
        <span class="detail-label">Was</span>
        <span class="detail-value">${formatDateTime(booking.start)}</span>
      </div>
      ${cancellationReason !== 'This meeting has been cancelled.' ? `
      <div class="detail-row">
        <span class="detail-label">Reason</span>
        <span class="detail-value" style="text-decoration: none;">${cancellationReason}</span>
      </div>
      ` : ''}
      <p style="margin-top: 20px; color: #6c757d;">
        📎 A calendar cancellation is attached to update your calendar.
      </p>
    </div>
    <div class="footer">
      <p>🛡️ Scheduled with ProtonScheduler · Privacy-first scheduling</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
    attachments: [{
      filename: `cancelled-${booking.title.replace(/[^a-z0-9]/gi, '-')}.ics`,
      content: icsContent,
      contentType: 'text/calendar; method=CANCEL',
    }],
    alternatives: [{
      contentType: 'text/calendar; method=CANCEL',
      content: icsContent,
    }],
  };
  
  const results = {
    attendee: null,
    organizer: null,
    errors: [],
  };
  
  // Send to attendee
  try {
    results.attendee = await transport.sendMail({
      ...emailContent,
      to: booking.attendee.email,
    });
    console.log(`✓ Cancellation sent to attendee: ${booking.attendee.email}`);
  } catch (error) {
    console.error(`✗ Failed to send cancellation to attendee:`, error.message);
    results.errors.push({ recipient: 'attendee', error: error.message });
  }
  
  // Send to organizer
  if (!options.skipOrganizer) {
    try {
      results.organizer = await transport.sendMail({
        ...emailContent,
        to: booking.organizer.email,
      });
      console.log(`✓ Cancellation sent to organizer: ${booking.organizer.email}`);
    } catch (error) {
      console.error(`✗ Failed to send cancellation to organizer:`, error.message);
      results.errors.push({ recipient: 'organizer', error: error.message });
    }
  }
  
  return results;
}

/**
 * Send a reminder email
 * @param {Object} booking - Booking data
 * @param {string} recipientType - 'attendee' or 'organizer'
 */
export async function sendReminder(booking, recipientType = 'attendee') {
  const transport = getTransporter();
  const recipient = recipientType === 'attendee' ? booking.attendee : booking.organizer;
  const otherParty = recipientType === 'attendee' ? booking.organizer : booking.attendee;
  
  const formatDateTime = (date) => {
    return new Date(date).toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };
  
  const email = {
    from: `"ProtonScheduler" <${config.email.from}>`,
    to: recipient.email,
    subject: `Reminder: ${booking.title} - ${formatDateTime(booking.start)}`,
    text: `
Meeting Reminder

You have an upcoming meeting:

${booking.title}
With: ${otherParty.name}
When: ${formatDateTime(booking.start)}
${booking.location ? `Where: ${booking.location}` : ''}

---
ProtonScheduler - Privacy-first scheduling
    `.trim(),
    html: `
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, sans-serif; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: #219EBC; padding: 2px; border-radius: 14px;">
    <div style="background: white; border-radius: 12px; padding: 30px;">
      <h2 style="color: #219EBC; margin-top: 0;">Meeting Reminder</h2>
      <h3 style="margin-bottom: 5px;">${booking.title}</h3>
      <p style="color: #666; margin-top: 5px;">with ${otherParty.name}</p>
      <p style="font-size: 18px; color: #333;"><strong>${formatDateTime(booking.start)}</strong></p>
      ${booking.location ? `<p>📍 ${booking.location}</p>` : ''}
      <p style="text-align: center; color: #6c757d; font-size: 14px; margin-top: 20px;">🛡️ Scheduled with ProtonScheduler · Privacy-first scheduling</p>
    </div>
  </div>
</body>
</html>
    `.trim(),
  };
  
  return await transport.sendMail(email);
}

export default {
  verifyEmailConfig,
  sendBookingConfirmation,
  sendCancellationNotice,
  sendReminder,
};
