/**
 * branding.js — Pro Custom Branding: sets --user-* AND --theme-* CSS variables.
 *
 * When custom branding is active, both the --user-* layer (consumed by
 * booking components) and the --theme-* layer (consumed by body/global
 * styles) are overridden so the entire page reflects the tenant's brand.
 *
 * SolidScheduler's own brand identity variables (--brand-primary, etc.) are
 * never touched — only the runtime theming layer changes.
 *
 * Theme-aware: accepts the active theme ('dark' | 'light') and applies
 * the appropriate background/text variant. Primary and accent colors
 * are theme-independent.
 */

const BRANDING_DEFAULTS = {
  bg:      '#0F172A',
  text:    '#F1F5F9',
  primary: '#6366F1',
  accent:  '#A5B4FC',
};

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

/** Returns true if the hex color is perceptually light (luminance > 0.5). */
function isLightColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.5;
}

function isDefault(val, def) {
  return !val || val.toUpperCase() === def.toUpperCase();
}

/**
 * Apply custom branding by setting --user-* CSS variables on :root.
 *
 * @param {Object} branding - { primaryColor, accentColor, backgroundColor, textColor, lightBackgroundColor, lightTextColor }
 * @param {Object} [defaults] - Override default comparison values
 * @param {string} [theme='dark'] - Active theme: 'dark' or 'light'
 * @returns {Function} Cleanup function that removes all set properties
 */
export function applyBranding(branding, defaults = BRANDING_DEFAULTS, theme = 'dark') {
  if (!branding) return () => {};

  const root = document.documentElement.style;
  const props = [];

  const set = (name, value) => {
    props.push(name);
    root.setProperty(name, value);
  };

  // ── Primary Color (theme-independent) ──────────────────────────────────
  if (branding.primaryColor && !isDefault(branding.primaryColor, defaults.primary)) {
    const c = branding.primaryColor;
    const rgb = hexToRgb(c);

    set('--user-primary', c);
    set('--user-primary-rgb', rgb);
    set('--color-user-primary', c);
    set('--color-user-dark', c);
    set('--color-primary-rgb', rgb);
  }

  // ── Accent Color (theme-independent) ───────────────────────────────────
  if (branding.accentColor && !isDefault(branding.accentColor, defaults.accent)) {
    const c = branding.accentColor;
    const rgb = hexToRgb(c);

    set('--user-accent', c);
    set('--user-accent-rgb', rgb);
    set('--color-user-light', c);
    set('--color-user-accent', c);
  }

  // ── Gradient Brand (for .btn-primary etc.) ─────────────────────────────
  if (branding.primaryColor && branding.accentColor) {
    set('--gradient-brand', `linear-gradient(135deg, ${branding.primaryColor}, ${branding.accentColor})`);
  } else if (branding.primaryColor && !isDefault(branding.primaryColor, defaults.primary)) {
    set('--gradient-brand', branding.primaryColor);
  }

  // ── Background Color (theme-aware) ─────────────────────────────────────
  const activeBg = (theme === 'light' && branding.lightBackgroundColor)
    ? branding.lightBackgroundColor
    : branding.backgroundColor;

  if (activeBg && !isDefault(activeBg, defaults.bg)) {
    const light = isLightColor(activeBg);

    // --user-* layer (booking components)
    set('--user-bg', activeBg);
    set('--user-gradient', activeBg);

    // --theme-* layer (body, global styles)
    set('--theme-bg-gradient', activeBg);

    if (light) {
      set('--user-card-bg', 'rgba(0, 0, 0, 0.03)');
      set('--user-card-border', 'rgba(0, 0, 0, 0.08)');
      set('--user-input-bg', 'rgba(0, 0, 0, 0.04)');
      set('--user-input-border', 'rgba(0, 0, 0, 0.10)');
      set('--user-border', 'rgba(0, 0, 0, 0.08)');
      set('--theme-card-bg', 'rgba(0, 0, 0, 0.03)');
      set('--theme-card-border', 'rgba(0, 0, 0, 0.08)');
    } else {
      set('--user-card-bg', 'rgba(255, 255, 255, 0.05)');
      set('--user-card-border', 'rgba(255, 255, 255, 0.10)');
      set('--user-input-bg', 'rgba(255, 255, 255, 0.06)');
      set('--user-input-border', 'rgba(255, 255, 255, 0.12)');
      set('--user-border', 'rgba(255, 255, 255, 0.08)');
      set('--theme-card-bg', 'rgba(255, 255, 255, 0.05)');
      set('--theme-card-border', 'rgba(255, 255, 255, 0.10)');
    }
  }

  // ── Text Color (theme-aware) ───────────────────────────────────────────
  const activeText = (theme === 'light' && branding.lightTextColor)
    ? branding.lightTextColor
    : branding.textColor;

  if (activeText && !isDefault(activeText, defaults.text)) {
    const tRgb = hexToRgb(activeText);

    // --user-* layer (booking components)
    set('--user-text', activeText);
    set('--user-text-rgb', tRgb);
    set('--user-text-muted', `rgba(${tRgb}, 0.55)`);
    set('--user-text-disabled', `rgba(${tRgb}, 0.35)`);

    // --theme-* layer (body, global styles)
    set('--theme-text-body', activeText);
    set('--theme-text-heading', activeText);
    set('--theme-text-muted', `rgba(${tRgb}, 0.55)`);
  }

  return () => { props.forEach(p => root.removeProperty(p)); };
}

export { BRANDING_DEFAULTS };
