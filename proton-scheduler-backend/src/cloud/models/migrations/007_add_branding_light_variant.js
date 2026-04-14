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
    // Columns may already exist in the base schema — skip if so
    const cols = db.pragma('table_info(branding)').map(c => c.name);
    if (!cols.includes('light_background_color')) {
      db.exec(`ALTER TABLE branding ADD COLUMN light_background_color TEXT`);
    }
    if (!cols.includes('light_text_color')) {
      db.exec(`ALTER TABLE branding ADD COLUMN light_text_color TEXT`);
    }
  },
};
