import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';

const mediaQuery = (dark) => {
  const listeners = new Set();
  return {
    matches: dark,
    addEventListener: (_e, fn) => listeners.add(fn),
    removeEventListener: (_e, fn) => listeners.delete(fn),
    emit: (matches) => listeners.forEach((fn) => fn({ matches })),
    listeners,
  };
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('useTheme', () => {
  it('starts dark, applies the theme to the page and remembers a choice', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

    act(() => result.current.setTheme('light'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(localStorage.getItem('solid-scheduler-theme')).toBe('light');
  });

  it('keeps a choice saved under the old name, and moves it to the new one', () => {
    localStorage.setItem('proton-theme', 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(localStorage.getItem('solid-scheduler-theme')).toBe('light');
    expect(localStorage.getItem('proton-theme')).toBeNull();
  });

  it("follows the system setting, and its changes, when set to 'system'", () => {
    const mq = mediaQuery(false);
    vi.stubGlobal('matchMedia', vi.fn(() => mq));
    const { result, unmount } = renderHook(() => useTheme());
    act(() => result.current.setTheme('system'));
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    act(() => mq.emit(true));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    unmount();
    expect(mq.listeners.size).toBe(0);
  });

  it('ignores an unknown theme, and works when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('neon'));
    expect(result.current.theme).toBe('dark');
  });
});
