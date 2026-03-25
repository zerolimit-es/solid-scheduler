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

  const isActive = (item) => item.matchKeys.includes(view);

  // Close mobile menu on outside click
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMobileMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
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
          ProtonScheduler
        </span>
      </div>

      {/* ── Mobile hamburger button ────────────────────────────── */}
      <button
        className="md:hidden flex flex-col gap-[5px] p-2 rounded-lg cursor-pointer border-none bg-transparent"
        onClick={() => setMobileMenuOpen(v => !v)}
        aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={mobileMenuOpen}
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
        <div
          ref={menuRef}
          className="md:hidden absolute top-full left-0 right-0 z-50 mt-2 p-2 rounded-xl border border-[var(--theme-nav-border)] bg-[var(--theme-card-bg,#1E293B)]"
          style={{ backdropFilter: 'blur(12px)' }}
          role="menu"
        >
          {navItems.map((item) => (
            <button
              key={item.label}
              onClick={item.onClick}
              role="menuitem"
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
            <button
              onClick={handleLogout}
              role="menuitem"
              className="w-full text-left px-4 py-2.5 rounded-lg text-sm font-medium border-none cursor-pointer text-red-400 hover:bg-red-500/10 bg-transparent"
            >
              Log out
            </button>
          </div>
        </div>
      )}

      {/* ── Theme toggle ──────────────────────────────────────────── */}
      {setTheme && (
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
          className="hidden md:flex w-8 h-8 rounded-lg items-center justify-center cursor-pointer transition-all duration-200"
          style={{
            border: '1px solid var(--theme-nav-border)',
            background: 'var(--theme-nav-bg)',
            color: 'var(--theme-text-muted)',
          }}
          title={`Theme: ${theme}`}
          aria-label={`Current theme: ${theme}. Click to change.`}
        >
          {theme === 'dark' ? <Moon size={15} strokeWidth={1.8} /> : theme === 'light' ? <Sun size={15} strokeWidth={1.8} /> : <Monitor size={15} strokeWidth={1.8} />}
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
          className="rounded-lg px-2 py-1.5 cursor-pointer flex items-center gap-1 transition-all duration-200"
          style={{
            background:   'var(--theme-logout-bg)',
            border:       '1px solid var(--theme-logout-border)',
            color:        'var(--theme-logout-color)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background    = 'rgba(239,68,68,0.08)';
            e.currentTarget.style.borderColor   = 'rgba(239,68,68,0.25)';
            e.currentTarget.style.color         = '#ef4444';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background    = 'var(--theme-logout-bg)';
            e.currentTarget.style.borderColor   = 'var(--theme-logout-border)';
            e.currentTarget.style.color         = 'var(--theme-logout-color)';
          }}
        >
          <LogOutIcon style={{ width: 14, height: 14 }} />
          <span className="text-xs">Log out</span>
        </button>
      </div>
    </header>
  );
}
