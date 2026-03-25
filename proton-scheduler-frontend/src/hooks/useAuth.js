/**
 * useAuth Hook
 *
 * Thin wrapper around @zerolimit/packages/solid-auth/react, configured for
 * ProtonScheduler.  v0.2.0 of the package supports extraStatusFields (oidcIssuer is
 * merged into user automatically), stable object refs, and server-side Pod
 * caching — so the workarounds that used to live here are no longer needed.
 */
import { useAuth as _useAuth } from '@zerolimit/packages/solid-auth/react';

const FALLBACK_PROVIDERS = [
  { name: 'Inrupt PodSpaces', url: 'https://login.inrupt.com' },
  { name: 'solidcommunity.net', url: 'https://solidcommunity.net' },
  { name: 'solidweb.org', url: 'https://solidweb.org' },
  { name: 'solidweb.me', url: 'https://solidweb.me' },
];

const AUTH_CONFIG = {
  apiBase: '',
  defaultProvider: 'https://login.inrupt.com',
  fallbackProviders: FALLBACK_PROVIDERS,
  extraStatusFields: ['oidcIssuer'],
};

export default function useAuth() {
  return _useAuth(AUTH_CONFIG);
}
