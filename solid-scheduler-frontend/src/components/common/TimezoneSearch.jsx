import React from 'react';

const ALL_TIMEZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone').map(tz => {
      try {
        const offset = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts().find(p => p.type === 'timeZoneName')?.value || '';
        return { id: tz, label: tz.replace(/_/g, ' ') + ' (' + offset + ')', search: (tz + ' ' + offset).toLowerCase() };
      } catch { return { id: tz, label: tz.replace(/_/g, ' '), search: tz.toLowerCase() }; }
    });
  } catch { return []; }
})();

export default function TimezoneSearch({ value, onChange }) {
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  const current = ALL_TIMEZONES.find(t => t.id === value);

  React.useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = query.length > 0
    ? ALL_TIMEZONES.filter(t => t.search.includes(query.toLowerCase())).slice(0, 20)
    : ALL_TIMEZONES.slice(0, 20);

  return (
    <div className="relative" ref={ref}>
      <input
        type="text"
        className="form-input"
        placeholder="Search timezone..."
        value={open ? query : (current ? current.label : value)}
        onFocus={() => { setOpen(true); setQuery(''); }}
        onChange={(e) => setQuery(e.target.value)}
      />
      {open && (
        <div className="absolute top-full left-0 right-0 z-50 max-h-60 overflow-y-auto mt-1 bg-[var(--theme-dropdown-bg)] border border-[var(--theme-dropdown-border)] rounded-[10px] shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
          {filtered.length === 0
            ? <div className="px-3.5 py-3 text-[13px] text-[var(--theme-text-disabled)] text-center">No timezones found</div>
            : filtered.map(t => (
                <div
                  key={t.id}
                  className={`px-3.5 py-2 text-[13px] cursor-pointer transition-colors duration-150 ${
                    t.id === value
                      ? 'bg-[rgba(var(--color-secondary-rgb),0.1)] text-[var(--color-secondary)]'
                      : 'text-[var(--theme-text-body)] hover:bg-[rgba(var(--color-primary-rgb),0.15)] hover:text-white'
                  }`}
                  onClick={() => { onChange(t.id); setOpen(false); setQuery(''); }}
                >
                  {t.label}
                </div>
              ))
          }
        </div>
      )}
    </div>
  );
}
