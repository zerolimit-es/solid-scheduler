/** Escape text for use in HTML, so names, titles and notes cannot inject markup. */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Strip characters that could start a new header from text used in an email subject or display name. */
export function singleLine(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
}
