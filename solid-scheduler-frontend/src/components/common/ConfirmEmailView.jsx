import React from 'react';

/**
 * The page the notification-email confirmation link opens. Opening it
 * confirms nothing: the address is confirmed when the button is pressed, so
 * mail scanners that open every link can't confirm an address for anyone.
 */
export default function ConfirmEmailView({ token }) {
  const [state, setState] = React.useState({ step: 'ask', message: null });

  const confirm = async () => {
    setState({ step: 'working', message: null });
    try {
      const res = await fetch('/api/public/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.confirmed) setState({ step: 'done', message: null });
      else setState({ step: 'failed', message: data.error || "This link couldn't be used." });
    } catch {
      setState({ step: 'ask', message: "Couldn't reach the server. Try again." });
    }
  };

  return (
    <main className="max-w-[440px] mx-auto text-center bg-[var(--theme-card-bg)] border border-[var(--theme-card-border)] rounded-2xl p-8">
      <h1 className="text-xl font-semibold text-[var(--color-text-primary)] m-0 mb-3">
        {state.step === 'done' ? 'Email confirmed' : 'Confirm your email'}
      </h1>
      {state.step === 'done' ? (
        <p className="text-sm text-[var(--theme-text-muted)] m-0 mb-6">You'll now get an email when someone books or cancels.</p>
      ) : state.step === 'failed' ? (
        <p role="alert" className="text-sm text-[var(--color-error)] m-0 mb-6">{state.message}</p>
      ) : (
        <>
          <p className="text-sm text-[var(--theme-text-muted)] m-0 mb-6">
            Confirm this address to get SolidScheduler booking notifications. If you didn't ask for them, close this page: nothing will be sent to you.
          </p>
          {state.message && <p role="alert" className="text-sm text-[var(--color-error)] m-0 mb-4">{state.message}</p>}
          <button type="button" className="btn btn-primary" onClick={confirm} disabled={state.step === 'working'}>
            {state.step === 'working' ? 'Confirming…' : 'Confirm my email'}
          </button>
        </>
      )}
      {(state.step === 'done' || state.step === 'failed') && (
        <a href="/" className="text-sm text-[var(--color-primary-light)]">Go to SolidScheduler</a>
      )}
    </main>
  );
}
