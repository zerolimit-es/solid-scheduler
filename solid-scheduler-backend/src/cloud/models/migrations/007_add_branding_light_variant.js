/**
 * Migration 007: Add light theme variant columns to branding
 *
 * Stores separate background and text colors for light mode so
 * each style preset can serve both a dark and light experience.
 * NULL = no custom light variant (falls back to SolidScheduler's light theme).
 */
export default {
  id: 7,
  name: 'add_branding_light_variant',
  up(db) {
    // The branding table belonged to the hosted edition and is no longer
    // created; only databases that have it get the columns.
    const cols = db.pragma('table_info(branding)').map(c => c.name);
    if (cols.length === 0) return;
    if (!cols.includes('light_background_color')) {
      db.exec(`ALTER TABLE branding ADD COLUMN light_background_color TEXT`);
    }
    if (!cols.includes('light_text_color')) {
      db.exec(`ALTER TABLE branding ADD COLUMN light_text_color TEXT`);
    }
  },
};
