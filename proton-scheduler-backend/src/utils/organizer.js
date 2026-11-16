/**
 * Who a booking is with: the name and email the account saved in its
 * settings. ORGANIZER_NAME / ORGANIZER_EMAIL are instance-wide fallbacks for
 * accounts that have not saved any.
 */
import config from '../config/index.js';

/**
 * @param {object|null} availability - The account's saved availability
 * @returns {{ name: string, email: string }}
 */
export function organizerIdentity(availability) {
  const pick = (...values) => values.find((v) => typeof v === 'string' && v.trim() !== '')?.trim() || '';
  return {
    name: pick(availability?.organizerName, availability?.name, config.organizer.name) || 'Organizer',
    email: pick(availability?.organizerEmail, availability?.email, config.organizer.email),
  };
}
