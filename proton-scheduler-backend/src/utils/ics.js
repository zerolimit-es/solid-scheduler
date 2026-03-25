/**
 * ICS (iCalendar) File Generation Utility
 * 
 * Generates RFC 5545 compliant iCalendar files for:
 * - Meeting invitations
 * - Calendar event imports (any standard calendar app)
 * - Cancellation notices
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Format a Date object to iCalendar datetime format (UTC with Z suffix)
 * @param {Date} date
 * @returns {string} YYYYMMDDTHHMMSSZ format
 */
function formatICSDateUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth()+1).padStart(2,'0');
  const d = String(date.getUTCDate()).padStart(2,'0');
  const h = String(date.getUTCHours()).padStart(2,'0');
  const mi = String(date.getUTCMinutes()).padStart(2,'0');
  const s = String(date.getUTCSeconds()).padStart(2,'0');
  return y+m+d+'T'+h+mi+s+'Z';
}

/**
 * Format a Date using server-local values (for TZID-qualified timestamps)
 * @param {Date} date
 * @returns {string} YYYYMMDDTHHMMSS format (no Z)
 */
function formatICSDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth()+1).padStart(2,'0');
  const d = String(date.getDate()).padStart(2,'0');
  const h = String(date.getHours()).padStart(2,'0');
  const mi = String(date.getMinutes()).padStart(2,'0');
  const s = String(date.getSeconds()).padStart(2,'0');
  return y+m+d+'T'+h+mi+s;
}

/**
 * Format a Date for ICS — uses TZID when timezone is provided, UTC otherwise
 */
function formatICSDate(date) {
  return formatICSDateUTC(date);
}

/**
 * Escape special characters in iCalendar text fields
 * @param {string} text 
 * @returns {string}
 */
function escapeICSText(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Fold long lines according to RFC 5545 (max 75 octets per line)
 * @param {string} line 
 * @returns {string}
 */
function foldLine(line) {
  const maxLength = 75;
  if (line.length <= maxLength) return line;
  
  const result = [];
  let remaining = line;
  
  while (remaining.length > maxLength) {
    result.push(remaining.substring(0, maxLength));
    remaining = ' ' + remaining.substring(maxLength);
  }
  result.push(remaining);
  
  return result.join('\r\n');
}

/**
 * @typedef {Object} EventData
 * @property {string} title - Event title/summary
 * @property {Date} start - Start datetime
 * @property {Date} end - End datetime
 * @property {string} [description] - Event description
 * @property {string} [location] - Event location
 * @property {Object} organizer - Organizer info
 * @property {string} organizer.name - Organizer name
 * @property {string} organizer.email - Organizer email
 * @property {Object} [attendee] - Attendee info
 * @property {string} attendee.name - Attendee name
 * @property {string} attendee.email - Attendee email
 * @property {string} [uid] - Unique identifier (auto-generated if not provided)
 * @property {string} [status] - Event status (CONFIRMED, TENTATIVE, CANCELLED)
 * @property {number} [sequence] - Sequence number for updates
 * @property {string} [method] - Calendar method (REQUEST, CANCEL, REPLY)
 * @property {Object} [recurrence] - Recurrence rule
 * @property {string} [recurrence.frequency] - DAILY, WEEKLY, MONTHLY, YEARLY
 * @property {number} [recurrence.interval] - Interval between occurrences
 * @property {number} [recurrence.count] - Number of occurrences
 * @property {Date} [recurrence.until] - End date for recurrence
 * @property {string[]} [recurrence.byDay] - Days of week
 * @property {Date[]} [excludedDates] - Dates to exclude (EXDATE)
 * @property {Date} [recurrenceId] - For exceptions: the original occurrence date
 */

/**
 * Build RRULE string from recurrence object
 * @param {Object} recurrence 
 * @returns {string}
 */
function buildRRuleString(recurrence) {
  if (!recurrence || !recurrence.frequency) return '';
  
  const parts = [`FREQ=${recurrence.frequency.toUpperCase()}`];
  
  if (recurrence.interval && recurrence.interval > 1) {
    parts.push(`INTERVAL=${recurrence.interval}`);
  }
  
  if (recurrence.count) {
    parts.push(`COUNT=${recurrence.count}`);
  } else if (recurrence.until) {
    parts.push(`UNTIL=${formatICSDate(new Date(recurrence.until))}`);
  }
  
  if (recurrence.byDay && recurrence.byDay.length > 0) {
    parts.push(`BYDAY=${recurrence.byDay.join(',')}`);
  }
  
  if (recurrence.byMonth && recurrence.byMonth.length > 0) {
    parts.push(`BYMONTH=${recurrence.byMonth.join(',')}`);
  }
  
  if (recurrence.byMonthDay && recurrence.byMonthDay.length > 0) {
    parts.push(`BYMONTHDAY=${recurrence.byMonthDay.join(',')}`);
  }
  
  return parts.join(';');
}

/**
 * Generate an ICS file content for an event
 * @param {EventData} event 
 * @returns {string} ICS file content
 */
export function generateICS(event) {
  const now = new Date();
  const uid = event.uid || `${uuidv4()}@protonscheduler.local`;
  const sequence = event.sequence || 0;
  const status = event.status || 'CONFIRMED';
  const method = event.method || 'REQUEST';
  
  const tz = event.timezone || null;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ProtonScheduler//Solid Calendar//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatICSDateUTC(now)}`,
  ];

  // Use TZID when timezone is provided (times are in user's local timezone),
  // otherwise fall back to UTC. TZID avoids "floating times not supported"
  // warnings in Proton Mail and other strict calendar clients.
  if (tz) {
    lines.push(`DTSTART;TZID=${tz}:${formatICSDateLocal(event.start)}`);
    lines.push(`DTEND;TZID=${tz}:${formatICSDateLocal(event.end)}`);
  } else {
    lines.push(`DTSTART:${formatICSDateUTC(event.start)}`);
    lines.push(`DTEND:${formatICSDateUTC(event.end)}`);
  }

  lines.push(`SUMMARY:${escapeICSText(event.title)}`);
  
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeICSText(event.description)}`);
  }
  
  if (event.location) {
    lines.push(`LOCATION:${escapeICSText(event.location)}`);
  }
  
  // Recurrence rule
  if (event.recurrence && event.recurrence.frequency) {
    const rrule = buildRRuleString(event.recurrence);
    if (rrule) {
      lines.push(`RRULE:${rrule}`);
    }
  }
  
  // Excluded dates (for cancelled instances)
  if (event.excludedDates && event.excludedDates.length > 0) {
    const exdates = event.excludedDates.map(d => formatICSDate(new Date(d))).join(',');
    lines.push(`EXDATE:${exdates}`);
  }
  
  // Recurrence ID (for exceptions - modified single instances)
  if (event.recurrenceId) {
    lines.push(`RECURRENCE-ID:${formatICSDate(new Date(event.recurrenceId))}`);
  }
  
  // Organizer
  lines.push(
    `ORGANIZER;CN=${escapeICSText(event.organizer.name)}:mailto:${event.organizer.email}`
  );
  
  // Attendee (if present)
  if (event.attendee) {
    lines.push(
      `ATTENDEE;CN=${escapeICSText(event.attendee.name)};RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${event.attendee.email}`
    );
  }
  
  lines.push(
    `STATUS:${status}`,
    `SEQUENCE:${sequence}`,
    'END:VEVENT',
    'END:VCALENDAR'
  );
  
  // Fold long lines and join with CRLF
  return lines.map(foldLine).join('\r\n');
}

/**
 * Generate ICS for a recurring event series with all occurrences
 * @param {EventData} event - Base event with recurrence
 * @param {Object} options - Options for occurrence generation
 * @returns {string} ICS file content with master event
 */
export function generateRecurringICS(event, options = {}) {
  // For recurring events, we just generate the master event with RRULE
  // Calendar apps will expand the occurrences
  return generateICS(event);
}

/**
 * Generate ICS for cancelling a single occurrence of a recurring event
 * @param {EventData} event - The recurring event
 * @param {Date} occurrenceDate - The specific occurrence to cancel
 * @returns {string} ICS file content
 */
export function generateOccurrenceCancellationICS(event, occurrenceDate) {
  return generateICS({
    ...event,
    status: 'CANCELLED',
    method: 'CANCEL',
    recurrenceId: occurrenceDate,
    sequence: (event.sequence || 0) + 1,
    // Remove recurrence rule - this is for a single instance
    recurrence: null,
    start: occurrenceDate,
    end: new Date(occurrenceDate.getTime() + (new Date(event.end) - new Date(event.start))),
  });
}

/**
 * Generate a cancellation ICS for an existing event
 * @param {EventData} event - Original event data with uid
 * @returns {string} ICS file content for cancellation
 */
export function generateCancellationICS(event) {
  return generateICS({
    ...event,
    status: 'CANCELLED',
    method: 'CANCEL',
    sequence: (event.sequence || 0) + 1,
    description: `CANCELLED: ${event.description || event.title}`,
  });
}

/**
 * Generate ICS for a recurring availability slot (informational)
 * @param {Object} availability - Availability settings
 * @returns {string} ICS content with VFREEBUSY
 */
export function generateAvailabilityICS(availability) {
  const now = new Date();
  const uid = `avail-${uuidv4()}@protonscheduler.local`;
  
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ProtonScheduler//Solid Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VFREEBUSY',
    `UID:${uid}`,
    `DTSTAMP:${formatICSDate(now)}`,
    `ORGANIZER;CN=${escapeICSText(availability.name)}:mailto:${availability.email}`,
  ];
  
  // Add free/busy periods for the next 4 weeks
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Start from Sunday
  
  const dayMap = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  
  for (let week = 0; week < 4; week++) {
    for (let day = 0; day < 7; day++) {
      const dayName = dayMap[day];
      const daySettings = availability.days[dayName];
      
      if (daySettings?.enabled) {
        const currentDate = new Date(weekStart);
        currentDate.setDate(currentDate.getDate() + (week * 7) + day);
        
        const [startHour, startMin] = daySettings.start.split(':').map(Number);
        const [endHour, endMin] = daySettings.end.split(':').map(Number);
        
        const start = new Date(currentDate);
        start.setHours(startHour, startMin, 0, 0);
        
        const end = new Date(currentDate);
        end.setHours(endHour, endMin, 0, 0);
        
        if (start > now) {
          lines.push(`FREEBUSY;FBTYPE=FREE:${formatICSDate(start)}/${formatICSDate(end)}`);
        }
      }
    }
  }
  
  lines.push(
    'END:VFREEBUSY',
    'END:VCALENDAR'
  );
  
  return lines.map(foldLine).join('\r\n');
}

/**
 * Parse basic ICS event data (limited parser for imports)
 * @param {string} icsContent 
 * @returns {Object|null} Parsed event data or null
 */
export function parseICSEvent(icsContent) {
  try {
    const lines = icsContent.replace(/\r\n /g, '').split(/\r?\n/);
    const event = {};
    
    for (const line of lines) {
      const [key, ...valueParts] = line.split(':');
      const value = valueParts.join(':');
      
      switch (key.split(';')[0]) {
        case 'UID':
          event.uid = value;
          break;
        case 'SUMMARY':
          event.title = value.replace(/\\n/g, '\n').replace(/\\,/g, ',');
          break;
        case 'DESCRIPTION':
          event.description = value.replace(/\\n/g, '\n').replace(/\\,/g, ',');
          break;
        case 'DTSTART':
          event.start = parseICSDate(value);
          break;
        case 'DTEND':
          event.end = parseICSDate(value);
          break;
        case 'LOCATION':
          event.location = value.replace(/\\n/g, '\n').replace(/\\,/g, ',');
          break;
        case 'STATUS':
          event.status = value;
          break;
      }
    }
    
    return event.uid ? event : null;
  } catch (error) {
    console.error('Failed to parse ICS:', error);
    return null;
  }
}

/**
 * Parse iCalendar date format to JavaScript Date
 * @param {string} icsDate 
 * @returns {Date}
 */
function parseICSDate(icsDate) {
  // Handle formats: 20240115T143000Z or 20240115T143000
  const match = icsDate.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (match) {
    const [, year, month, day, hour, minute, second] = match;
    return new Date(Date.UTC(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      parseInt(hour),
      parseInt(minute),
      parseInt(second)
    ));
  }
  return new Date(icsDate);
}

/**
 * Parse a full VCALENDAR file containing multiple VEVENTs.
 * Used for ICS import (e.g. from Proton Calendar export).
 *
 * @param {string} icsContent — Raw ICS text
 * @returns {Array<Object>} Parsed events with { uid, title, start, end, description, location, rrule, allDay }
 */
export function parseICSCalendar(icsContent) {
  if (!icsContent) return [];

  // Unfold continuation lines (RFC 5545: lines starting with space/tab are continuations)
  const unfolded = icsContent.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const events = [];
  let inEvent = false;
  let current = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current && (current.title || current.uid)) {
        // Format dates as naive local strings "YYYY-MM-DD HH:MM" for SQLite storage
        if (current._startDate) {
          current.start = dateToNaive(current._startDate);
          current.allDay = current._allDay || false;
        }
        if (current._endDate) {
          current.end = dateToNaive(current._endDate);
        }
        delete current._startDate;
        delete current._endDate;
        delete current._allDay;
        events.push(current);
      }
      inEvent = false;
      current = null;
      continue;
    }

    if (!inEvent || !current) continue;

    // Split on first colon, handling parameters like DTSTART;VALUE=DATE:20240115
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const keyPart = line.substring(0, colonIdx);
    const value = line.substring(colonIdx + 1);
    const baseKey = keyPart.split(';')[0];

    switch (baseKey) {
      case 'UID':
        current.uid = value;
        break;
      case 'SUMMARY':
        current.title = unescapeICS(value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeICS(value);
        break;
      case 'DTSTART': {
        const isDateOnly = keyPart.includes('VALUE=DATE') && !keyPart.includes('VALUE=DATE-TIME');
        current._startDate = parseICSDate(value);
        current._allDay = isDateOnly;
        break;
      }
      case 'DTEND':
        current._endDate = parseICSDate(value);
        break;
      case 'LOCATION':
        current.location = unescapeICS(value);
        break;
      case 'RRULE':
        current.rrule = value; // Store raw RRULE string
        break;
      case 'STATUS':
        current.status = value;
        break;
    }
  }

  return events;
}

function unescapeICS(str) {
  return (str || '')
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function dateToNaive(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

export default {
  generateICS,
  generateRecurringICS,
  generateOccurrenceCancellationICS,
  generateCancellationICS,
  generateAvailabilityICS,
  parseICSEvent,
  parseICSCalendar,
};
