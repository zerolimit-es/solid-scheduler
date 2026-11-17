import React from 'react';
import { LoaderIcon } from '../common/Icons';

const OTHER = '__other__';

/** True for an http(s) URL. */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export default function LoginScreen({ providers: allProviders, selectedProvider, setSelectedProvider, handleLogin }) {
  // Entries without an address (the package lists a "Self-hosted" placeholder)
  // are covered by "Other provider…", where the address is typed in
  const providers = allProviders.filter((p) => typeof p.url === 'string' && p.url);
  // The selected provider is either one from the list or a URL typed in
  const listed = providers.some((p) => p.url === selectedProvider);
  const [typing, setTyping] = React.useState(false);
  const showUrlField = typing || (!listed && providers.length > 0 && !!selectedProvider);
  const urlValid = !showUrlField || isHttpUrl(selectedProvider);

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
      <div className="bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-3xl p-12 max-w-[420px] w-full backdrop-blur-[10px]">
        <div className="text-center mb-8">
          <h1 className="font-display text-[1.75rem] mb-2 bg-gradient-to-br from-brand-primary to-brand-accent bg-clip-text text-transparent">SolidScheduler</h1>
          <p className="text-[var(--theme-text-muted)] m-0">Privacy-first scheduling</p>
        </div>
        <div>
          <p className="text-[var(--theme-text-disabled)] text-center mb-6 leading-relaxed">
            Your data lives in your Solid Pod.
            Connect your identity to get started.
          </p>
          <div className="mb-6">
            <label htmlFor="identity-provider" className="block text-sm text-[var(--theme-text-disabled)] mb-2">Solid Identity Provider</label>
            <select
              id="identity-provider"
              className="w-full py-3.5 px-4 bg-[var(--theme-input-bg)] border border-[var(--theme-input-border)] rounded-[10px] text-[var(--theme-input-color)] text-[0.9375rem]"
              value={showUrlField ? OTHER : selectedProvider}
              onChange={(e) => {
                if (e.target.value === OTHER) {
                  setTyping(true);
                  setSelectedProvider('');
                } else {
                  setTyping(false);
                  setSelectedProvider(e.target.value);
                }
              }}
            >
              {providers.map(p => (
                <option key={p.url} value={p.url}>{p.name}</option>
              ))}
              <option value={OTHER}>Other provider…</option>
            </select>
            {showUrlField && (
              <>
                <label htmlFor="identity-provider-url" className="block text-sm text-[var(--theme-text-disabled)] mt-4 mb-2">Provider address</label>
                <input
                  id="identity-provider-url"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  placeholder="https://id.example.org"
                  className="w-full py-3.5 px-4 bg-[var(--theme-input-bg)] border border-[var(--theme-input-border)] rounded-[10px] text-[var(--theme-input-color)] text-[0.9375rem]"
                  value={selectedProvider}
                  onChange={(e) => setSelectedProvider(e.target.value.trim())}
                  aria-invalid={!!selectedProvider && !urlValid}
                  aria-describedby="identity-provider-url-hint"
                />
                <p id="identity-provider-url-hint" className="text-xs text-[var(--theme-text-muted)] mt-2 mb-0">
                  The address of the server where you created your Solid account.
                </p>
              </>
            )}
          </div>
          <button className="btn btn-primary w-full p-4 text-base disabled:opacity-60 disabled:cursor-not-allowed" onClick={handleLogin} disabled={!selectedProvider || !urlValid}>
            Login with Solid
          </button>
          <div className="text-center mt-6 pt-6 border-t border-[var(--theme-header-border)]">
            <p className="text-[var(--theme-text-muted)] m-0 mb-2 text-sm">Don't have a Solid Pod?</p>
            <a href="https://solidproject.org/users/get-a-pod" target="_blank" rel="noopener noreferrer"
               className="text-brand-light text-sm no-underline hover:underline">
              Get one free →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
