import React from 'react';
import { api } from '../../services/api';
import { CalendarIcon, CheckIcon } from '../common/Icons';

/**
 * Subscribable calendar feed (ICS) for the signed-in account.
 * The URL is a secret: anyone with it can read the calendar, so it can be
 * regenerated, which stops the old URL working.
 */
export default function CalendarFeedCard({ setError }) {
  const [feedUrl, setFeedUrl] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);

  const toUrl = (feedPath) => `${window.location.origin}${feedPath}`;

  React.useEffect(() => {
    let active = true;
    api.calendar.getFeedToken()
      .then((data) => { if (active) setFeedUrl(toUrl(data.feedPath)); })
      .catch((err) => {
        console.error('[CalendarFeed] Load failed:', err.message);
        if (active) setFailed(true);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError?.('Could not copy to the clipboard. Select the URL and copy it manually.');
    }
  };

  const handleRegenerate = async () => {
    if (!confirm('Create a new feed URL? Calendars subscribed to the current URL will stop updating until you subscribe them to the new one.')) return;
    setRegenerating(true);
    try {
      const data = await api.calendar.regenerateFeedToken();
      setFeedUrl(toUrl(data.feedPath));
      setFailed(false);
    } catch (err) {
      console.error('[CalendarFeed] Regenerate failed:', err.message);
      setError?.(err.message);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-2xl p-6 backdrop-blur-[10px] shadow-[var(--shadow-sm)] col-span-1 md:col-span-2">
      <div className="flex justify-between items-start mb-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text-primary)] m-0 mb-1">Calendar Feed</h2>
          <p className="text-[0.8125rem] text-[var(--theme-text-muted)] m-0">
            Subscribe to this URL in Proton Calendar, Apple Calendar or any app that supports ICS feeds. Keep it private: anyone with the link can see your meetings.
          </p>
        </div>
        <div className="w-10 h-10 shrink-0 bg-[linear-gradient(135deg,rgba(var(--color-primary-rgb),0.2),rgba(var(--color-secondary-rgb),0.1))] rounded-[10px] flex items-center justify-center">
          <CalendarIcon />
        </div>
      </div>
      <div className="flex items-center gap-3 bg-[var(--theme-booking-link-bg)] border border-[var(--theme-card-border)] rounded-[10px] px-4 py-3">
        {loading ? (
          <span className="flex-1 font-display text-xs text-[var(--theme-text-muted)] animate-pulse">Loading feed URL…</span>
        ) : failed && !feedUrl ? (
          <span className="flex-1 text-xs text-[var(--theme-text-muted)]">The calendar feed isn't available right now.</span>
        ) : (
          <>
            <span
              className="flex-1 min-w-0 font-display text-xs text-[var(--color-primary)] overflow-hidden text-ellipsis whitespace-nowrap select-all"
              title={feedUrl}
            >
              {feedUrl}
            </span>
            <button
              className="py-1.5 px-3.5 bg-brand-primary hover:bg-brand-primary/90 border-none rounded-md text-white text-xs font-medium cursor-pointer flex items-center gap-1 transition-all duration-200"
              onClick={handleCopy}
            >
              {copied ? <><CheckIcon style={{ width: 14, height: 14 }} /> Copied!</> : 'Copy'}
            </button>
          </>
        )}
      </div>
      {!loading && (
        <button
          className="mt-3 p-0 bg-transparent border-none text-xs text-[var(--theme-text-muted)] underline cursor-pointer disabled:cursor-wait disabled:opacity-60"
          onClick={handleRegenerate}
          disabled={regenerating}
        >
          {regenerating ? 'Creating new URL…' : 'Create a new URL (stops the old one working)'}
        </button>
      )}
    </div>
  );
}
