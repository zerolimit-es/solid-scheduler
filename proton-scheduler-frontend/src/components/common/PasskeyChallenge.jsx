import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { KeyRound } from 'lucide-react';
import { api } from '../../services/api';
import { LoaderIcon } from './Icons';

export default function PasskeyChallenge({ onSuccess }) {
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);

  const handleVerify = async () => {
    setVerifying(true);
    setError(null);
    try {
      // Timeout the auth-options fetch to prevent hanging requests from
      // saturating the connection pool and freezing the browser.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      let options;
      try {
        options = await api.passkey.authOptions({ signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      const credential = await startAuthentication({ optionsJSON: options });
      await api.passkey.authVerify(credential);
      onSuccess();
    } catch (err) {
      if (err.name === 'AbortError') {
        setError('Request timed out — please try again.');
      } else if (err.name === 'NotAllowedError') {
        setError('Passkey verification was cancelled or timed out.');
      } else {
        setError(err.message || 'Verification failed');
      }
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen p-6">
      <div className="card max-w-[420px] w-full p-8">
        <div className="text-center mb-6">
          <KeyRound size={48} strokeWidth={1.5} className="text-brand-primary mb-3" />
          <h2 className="card-title mb-2">Passkey Verification</h2>
          <p className="card-subtitle">Use your registered passkey to complete sign-in.</p>
        </div>

        {error && (
          <div className="text-red-500 bg-red-500/10 p-3 rounded-lg mb-4 text-[13px]">
            {error}
          </div>
        )}

        <button
          className="btn btn-primary w-full"
          onClick={handleVerify}
          disabled={verifying}
        >
          {verifying ? (
            <><LoaderIcon className="btn-loader" /> Verifying...</>
          ) : (
            'Verify with Passkey'
          )}
        </button>
      </div>
    </div>
  );
}
