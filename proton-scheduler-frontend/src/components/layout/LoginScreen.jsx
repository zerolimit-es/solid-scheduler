import React from 'react';
import { LoaderIcon } from '../common/Icons';

export default function LoginScreen({ providers, selectedProvider, setSelectedProvider, handleLogin }) {
  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
      <div className="bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-3xl p-12 max-w-[420px] w-full backdrop-blur-[10px]">
        <div className="text-center mb-8">
          <h1 className="font-display text-[1.75rem] mb-2 bg-gradient-to-br from-brand-primary to-brand-accent bg-clip-text text-transparent">ProtonScheduler</h1>
          <p className="text-[var(--theme-text-muted)] m-0">Privacy-first scheduling</p>
        </div>
        <div>
          <p className="text-[var(--theme-text-disabled)] text-center mb-6 leading-relaxed">
            Your data lives in your Solid Pod.
            Connect your identity to get started.
          </p>
          <div className="mb-6">
            <label className="block text-sm text-[var(--theme-text-disabled)] mb-2">Solid Identity Provider</label>
            <select
              className="w-full py-3.5 px-4 bg-[var(--theme-input-bg)] border border-[var(--theme-input-border)] rounded-[10px] text-[var(--theme-input-color)] text-[0.9375rem]"
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
            >
              {providers.map(p => (
                <option key={p.url} value={p.url}>{p.name}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary w-full p-4 text-base" onClick={handleLogin}>
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
