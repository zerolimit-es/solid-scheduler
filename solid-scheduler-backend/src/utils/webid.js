/**
 * WebID display name and slug extraction utilities.
 *
 * Handles multiple Solid WebID URL formats:
 *   - CSS (solidcommunity.net): https://damien.solidcommunity.net/profile/card#me → "damien"
 *   - Inrupt PodSpaces:         https://id.inrupt.com/damien                     → "damien"
 *   - Generic path-based:       https://pod.example.com/damien/profile/card#me   → "damien"
 */

/**
 * Extract a human-readable display name from a Solid WebID URL.
 *
 * @param {string} webId
 * @returns {string}
 */
export function extractDisplayName(webId) {
  try {
    const url = new URL(webId);
    const hostParts = url.hostname.split('.');
    const segments = url.pathname.split('/').filter(Boolean);

    // CSS-style: username is the first subdomain label
    // Pattern: https://damien.solidcommunity.net/profile/card#me
    // Detected by: has fragment + 3+ hostname labels + first path is "profile"
    if (url.hash && hostParts.length >= 3 && segments[0] === 'profile') {
      return hostParts[0];
    }

    // Path-based with fragment: username is the first path segment
    // e.g. https://pod.example.com/johndoe/profile/card#me → "johndoe"
    if (url.hash && segments.length >= 2) {
      return segments[0];
    }

    // Simple path-based: last non-empty path segment
    // e.g. https://id.inrupt.com/damien → "damien"
    if (segments.length > 0) {
      return segments[segments.length - 1];
    }
  } catch {
    // Not a valid URL — fall through
  }
  return 'User';
}

/**
 * Derive a URL-safe booking slug from a WebID.
 *
 * @param {string} webId
 * @returns {string}
 */
export function extractSlug(webId) {
  return extractDisplayName(webId)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'user';
}
