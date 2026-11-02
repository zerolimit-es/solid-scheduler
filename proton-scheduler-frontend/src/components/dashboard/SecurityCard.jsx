import React from 'react';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { KeyRound } from 'lucide-react';
import { api } from '../../services/api';
import { LoaderIcon } from '../common/Icons';

/** SQLite timestamps are UTC without a zone ("YYYY-MM-DD HH:MM:SS"). */
function formatDate(value) {
  if (!value) return null;
  const iso = /Z|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function describeError(err) {
  if (err?.name === 'NotAllowedError') return 'Passkey setup was cancelled or timed out.';
  if (err?.name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  return err?.message || 'Something went wrong. Please try again.';
}

/**
 * Passkey management. Any registered passkey turns on the passkey check at
 * sign-in (MFA); removing the last one turns it off.
 */
export default function SecurityCard() {
  const supported = React.useMemo(() => browserSupportsWebAuthn(), []);
  const [passkeys, setPasskeys] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [adding, setAdding] = React.useState(false);
  const [removingId, setRemovingId] = React.useState(null);
  const [deviceName, setDeviceName] = React.useState('');
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const data = await api.passkey.list();
      setPasskeys(data.passkeys || []);
    } catch (err) {
      setError(`Could not load your passkeys: ${describeError(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const options = await api.passkey.registerOptions();
      const credential = await startRegistration({ optionsJSON: options });
      await api.passkey.registerVerify(credential, deviceName.trim() || undefined);
      setDeviceName('');
      setNotice(passkeys.length === 0
        ? 'Passkey added. You will be asked for it each time you sign in.'
        : 'Passkey added.');
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (pk) => {
    const last = passkeys.length === 1;
    const message = last
      ? `Remove "${pk.deviceName}"? It is your only passkey, so sign-in will no longer ask for one.`
      : `Remove "${pk.deviceName}"? You won't be able to use it to sign in.`;
    if (!confirm(message)) return;
    setRemovingId(pk.id);
    setError(null);
    setNotice(null);
    try {
      await api.passkey.remove(pk.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setRemovingId(null);
    }
  };

  const enabled = passkeys.length > 0;

  return (
    <div className="bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-2xl p-6 backdrop-blur-[10px] shadow-[var(--shadow-sm)] col-span-1 md:col-span-2">
      <div className="flex justify-between items-start mb-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text-primary)] m-0 mb-1">Security</h2>
          <p className="text-[0.8125rem] text-[var(--theme-text-muted)] m-0">
            {loading
              ? 'Passkeys add a second step when you sign in.'
              : enabled
                ? 'Passkey check is on: after signing in with your Solid account, you confirm with one of these passkeys.'
                : 'Add a passkey to require a second step after signing in with your Solid account.'}
          </p>
        </div>
        <div className="w-10 h-10 shrink-0 bg-[linear-gradient(135deg,rgba(var(--color-primary-rgb),0.2),rgba(var(--color-secondary-rgb),0.1))] rounded-[10px] flex items-center justify-center">
          <KeyRound size={20} strokeWidth={1.75} />
        </div>
      </div>

      {error && (
        <div role="alert" className="text-red-500 bg-red-500/10 p-3 rounded-lg mb-4 text-[13px]">{error}</div>
      )}
      {notice && (
        <div role="status" className="text-status-success bg-[rgba(var(--color-secondary-rgb),0.1)] p-3 rounded-lg mb-4 text-[13px]">{notice}</div>
      )}

      {loading ? (
        <p className="text-xs text-[var(--theme-text-muted)] animate-pulse m-0">Loading passkeys…</p>
      ) : (
        <>
          {passkeys.length > 0 && (
            <ul className="list-none p-0 m-0 mb-4 flex flex-col gap-2" aria-label="Your passkeys">
              {passkeys.map((pk) => (
                <li
                  key={pk.id}
                  className="flex items-center gap-3 bg-[var(--theme-booking-link-bg)] border border-[var(--theme-card-border)] rounded-[10px] px-4 py-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-[var(--color-text-primary)] overflow-hidden text-ellipsis whitespace-nowrap">{pk.deviceName}</div>
                    <div className="text-[0.6875rem] text-[var(--theme-text-muted)]">
                      {formatDate(pk.createdAt) ? `Added ${formatDate(pk.createdAt)}` : 'Added'}
                      {' · '}
                      {formatDate(pk.lastUsedAt) ? `Last used ${formatDate(pk.lastUsedAt)}` : 'Not used yet'}
                    </div>
                  </div>
                  <button
                    className="py-1.5 px-3 bg-transparent border border-[var(--theme-card-border)] rounded-md text-xs text-[var(--theme-text-muted)] cursor-pointer hover:text-red-500 hover:border-red-500/50 transition-all duration-200 disabled:opacity-60 disabled:cursor-wait"
                    onClick={() => handleRemove(pk)}
                    disabled={removingId === pk.id}
                    aria-label={`Remove passkey ${pk.deviceName}`}
                  >
                    {removingId === pk.id ? 'Removing…' : 'Remove'}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {supported ? (
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="Name, e.g. Work laptop (optional)"
                maxLength={60}
                aria-label="Passkey name"
                className="flex-1 min-w-0 bg-[var(--theme-booking-link-bg)] border border-[var(--theme-card-border)] rounded-md px-3 py-2 text-sm text-[var(--color-text-primary)]"
              />
              <button
                className="py-2 px-4 bg-brand-primary hover:bg-brand-primary/90 border-none rounded-md text-white text-sm font-medium cursor-pointer flex items-center justify-center gap-2 transition-all duration-200 disabled:opacity-60 disabled:cursor-wait"
                onClick={handleAdd}
                disabled={adding}
              >
                {adding ? <><LoaderIcon style={{ width: 14, height: 14 }} /> Waiting for passkey…</> : 'Add a passkey'}
              </button>
            </div>
          ) : (
            <p className="text-xs text-[var(--theme-text-muted)] m-0">This browser doesn't support passkeys.</p>
          )}
        </>
      )}
    </div>
  );
}
