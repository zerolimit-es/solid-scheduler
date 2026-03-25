/**
 * Migration 007: Add light theme variant columns to branding
 *
 * Stores separate background and text colors for light mode so
 * each style preset can serve both a dark and light experience.
 * NULL = no custom light variant (falls back to ProtonScheduler's light theme).
 */
export default {
  id: 7,
  name: 'add_branding_light_variant',
  up(db) {
    db.exec(`ALTER TABLE branding ADD COLUMN light_background_color TEXT`);
    db.exec(`ALTER TABLE branding ADD COLUMN light_text_color TEXT`);
  },
};
