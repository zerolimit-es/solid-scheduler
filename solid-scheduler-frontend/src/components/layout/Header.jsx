import React, { useState, useRef, useEffect } from 'react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { LogOutIcon } from '../common/Icons';
import { extractDisplayName } from '../../utils/webid';

// ── Nav item definitions ───────────────────────────────────────────────
function buildNavItems({ setView }) {
  return [
    {
      label:     'Dashboard',
      matchKeys: ['dashboard'],
      onClick:   () => setView('dashboard'),
    },
    {
      label:     'Book',
      matchKeys: ['booking', 'form', 'confirmation'],
      onClick:   () => setView('booking'),
    },
    {
      label:     'Support',
      matchKeys: ['support'],
      onClick:   () => setView('support'),
    },
  ];
}

// ── Component ──────────────────────────────────────────────────────────
export default function Header({
  user,
  view,
  setView,
  handleLogout,
  theme        = 'dark',
  setTheme,
}) {
  const displayName = extractDisplayName(user?.webId ?? '');
  const navItems    = buildNavItems({ setView });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const toggleRef = useRef(null);
  const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

  const isActive = (item) => item.matchKeys.includes(view);

  // Close the mobile menu on a click outside it, or on Escape. The menu
  // button is not "outside": it toggles the menu itself, and closing here
  // too would have it reopen on the same click.
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onPointer = (e) => {
      if (menuRef.current?.contains(e.target) || toggleRef.current?.contains(e.target)) return;
      setMobileMenuOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setMobileMenuOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [mobileMenuOpen]);

  // Close mobile menu when view changes
  useEffect(() => { setMobileMenuOpen(false); }, [view]);

  return (
    <header className="flex justify-between items-center mb-8 pb-6 flex-wrap gap-4 relative"
      style={{ borderBottom: '1px solid var(--theme-header-border)' }}>

      {/* ── Logo ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5">
        <span
          className="font-display text-[1.05rem] font-bold tracking-[0.01em] leading-none bg-gradient-to-br from-brand-primary to-brand-light bg-clip-text text-transparent"
        >
          SolidScheduler
        </span>
      </div>

      {/* ── Mobile hamburger button ────────────────────────────── */}
      <button
        ref={toggleRef}
        className="md:hidden flex flex-col gap-[5px] p-2 rounded-lg cursor-pointer border-none bg-transparent"
        onClick={() => setMobileMenuOpen(v => !v)}
        aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={mobileMenuOpen}
        aria-controls="mobile-menu"
      >
        <span className={`block w-5 h-[2px] bg-[var(--theme-text-body)] transition-all duration-200 ${mobileMenuOpen ? 'rotate-45 translate-y-[7px]' : ''}`} />
        <span className={`block w-5 h-[2px] bg-[var(--theme-text-body)] transition-all duration-200 ${mobileMenuOpen ? 'opacity-0' : ''}`} />
        <span className={`block w-5 h-[2px] bg-[var(--theme-text-body)] transition-all duration-200 ${mobileMenuOpen ? '-rotate-45 -translate-y-[7px]' : ''}`} />
      </button>

      {/* ── Desktop Navigation ─────────────────────────────────── */}
      <nav
        className="hidden md:flex gap-px p-[3px] bg-[var(--theme-nav-bg)] border border-[var(--theme-nav-border)] rounded-[9px]"
        aria-label="Main navigation"
      >
        {navItems.map((item) => (
          <button
            key={item.label}
            onClick={item.onClick}
            aria-current={isActive(item) ? 'page' : undefined}
            className={`px-3.5 py-[5px] rounded-[7px] text-[0.75rem] font-medium whitespace-nowrap border-none cursor-pointer transition-all duration-150 ${
              isActive(item)
                ? 'bg-brand-primary text-white'
                : 'bg-transparent text-[var(--theme-text-muted)] hover:text-[var(--theme-text-body)] hover:bg-brand-light/[0.06]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {/* ── Mobile Navigation Dropdown ─────────────────────────── */}
      {mobileMenuOpen && (
        <nav
          ref={menuRef}
          id="mobile-menu"
          className="md:hidden absolute top-full left-0 right-0 z-50 mt-2 p-2 rounded-xl border border-[var(--theme-nav-border)] bg-[var(--theme-card-bg,#1E293B)]"
          style={{ backdropFilter: 'blur(12px)' }}
          aria-label="Main navigation"
        >
          {navItems.map((item) => (
            <button
              key={item.label}
              onClick={item.onClick}
              aria-current={isActive(item) ? 'page' : undefined}
              className={`w-full text-left px-4 py-2.5 rounded-lg text-sm font-medium border-none cursor-pointer transition-all duration-150 ${
                isActive(item)
                  ? 'bg-brand-primary text-white'
                  : 'bg-transparent text-[var(--theme-text-muted)] hover:text-[var(--theme-text-body)] hover:bg-brand-light/[0.06]'
              }`}
            >
              {item.label}
            </button>
          ))}
          <div className="border-t border-[var(--theme-nav-border)] mt-2 pt-2">
            {setTheme && (
              <button
                onClick={() => setTheme(nextTheme)}
                className="w-full text-left px-4 py-2.5 rounded-lg text-sm font-medium border-none cursor-pointer bg-transparent text-[var(--theme-text-muted)] hover:text-[var(--theme-text-body)] hover:bg-brand-light/[0.06] flex items-center gap-2"
              >
                <ThemeIcon size={15} strokeWidth={1.8} aria-hidden="true" />
                Theme: {theme} <span className="sr-only">(switch to {nextTheme})</span>
              </button>
            )}
            <button
              onClick={handleLogout}
              className="w-full text-left px-4 py-2.5 rounded-lg text-sm font-medium border-none cursor-pointer text-red-400 hover:bg-red-500/10 bg-transparent"
            >
              Log out
            </button>
          </div>
        </nav>
      )}

      {/* ── Theme toggle ──────────────────────────────────────────── */}
      {setTheme && (
        <button
          onClick={() => setTheme(nextTheme)}
          className="hidden md:flex w-8 h-8 rounded-lg items-center justify-center cursor-pointer transition-all duration-200"
          style={{
            border: '1px solid var(--theme-nav-border)',
            background: 'var(--theme-nav-bg)',
            color: 'var(--theme-text-muted)',
          }}
          title={`Theme: ${theme}`}
          aria-label={`Current theme: ${theme}. Click to change.`}
        >
          <ThemeIcon size={15} strokeWidth={1.8} />
        </button>
      )}

      {/* ── User menu (desktop) ────────────────────────────────── */}
      <div className="hidden md:flex items-center gap-2.5">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
          style={{ background: 'var(--gradient-brand)' }}
          aria-hidden="true"
        >
          {displayName[0]?.toUpperCase() ?? '?'}
        </div>
        <span
          className="text-[13px] font-medium max-w-[140px] overflow-hidden text-ellipsis whitespace-nowrap"
          style={{ color: 'var(--theme-user-name-color)' }}
          title={displayName}
        >
          {displayName}
        </span>
        <button
          onClick={handleLogout}
          title="Log out"
          aria-label="Log out"
          className="rounded-lg px-2 py-1.5 cursor-pointer flex items-center gap-1 transition-all duration-200 border bg-[var(--theme-logout-bg)] border-[var(--theme-logout-border)] text-[var(--theme-logout-color)] hover:bg-[rgba(239,68,68,0.08)] hover:border-[rgba(239,68,68,0.25)] hover:text-[#ef4444] focus-visible:bg-[rgba(239,68,68,0.08)] focus-visible:border-[rgba(239,68,68,0.25)] focus-visible:text-[#ef4444]"
        >
          <LogOutIcon style={{ width: 14, height: 14 }} />
          <span className="text-xs">Log out</span>
        </button>
      </div>
    </header>
  );
}
