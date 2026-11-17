import { useState, useEffect } from 'react';

const STORAGE_KEY = 'solid-scheduler-theme';
const OLD_STORAGE_KEY = 'proton-theme'; // read once, so a saved choice survives the rename
const THEMES = ['dark', 'light', 'system'];

// Browser storage can be unavailable (private windows, blocked site data,
// some embedded views): reading or writing it then throws. The theme is a
// convenience, so it falls back to the default instead of breaking the app.
function readSaved() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(OLD_STORAGE_KEY);
    return THEMES.includes(saved) ? saved : null;
  } catch {
    return null;
  }
}

function save(theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
    localStorage.removeItem(OLD_STORAGE_KEY);
  } catch {
    // Not saved; the choice still applies until the page is closed
  }
}

function systemPrefersDark() {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return true;
  }
}

function applyTheme(preference) {
  const resolved = preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function useTheme() {
  const [theme, setThemeState] = useState(() => readSaved() || 'dark');

  // Apply theme on mount and whenever it changes
  useEffect(() => {
    applyTheme(theme);
    save(theme);
  }, [theme]);

  // When system theme is selected, listen for OS-level changes
  useEffect(() => {
    if (theme !== 'system' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = (newTheme) => setThemeState(THEMES.includes(newTheme) ? newTheme : 'dark');

  return { theme, setTheme };
}
