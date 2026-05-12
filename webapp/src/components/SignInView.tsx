import { FormEvent, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import {
  completeDevCallback,
  getAuthConfig,
  startGoogleAuth,
} from '../lib/api';

export function SignInView(props: {
  onSignedIn: () => Promise<void> | void;
}): JSX.Element {
  const location = useLocation();
  const [email, setEmail] = useState('owner@example.com');
  const [name, setName] = useState('Owner');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDevLogin, setShowDevLogin] = useState(false);
  const returnTo = `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    let cancelled = false;

    const loadConfig = async () => {
      try {
        const config = await getAuthConfig();
        if (!cancelled) setShowDevLogin(config.devMode);
      } catch {
        if (!cancelled) setShowDevLogin(false);
      }
    };

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const signInWithRedirect = async () => {
    setBusy(true);
    setError(null);
    try {
      const auth = await startGoogleAuth({ returnTo });
      window.location.assign(auth.authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start sign-in');
      setBusy(false);
    }
  };

  const completeDevLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const auth = await startGoogleAuth({ returnTo });
      const callback = new URL(auth.authorizationUrl, window.location.origin);
      callback.searchParams.set('email', email.trim());
      callback.searchParams.set('name', name.trim() || 'User');
      await completeDevCallback(callback.toString());
      await props.onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <h1>ClawRocket</h1>
        <p>Sign in to access your talks and machine-local context.</p>
        <button
          type="button"
          onClick={signInWithRedirect}
          disabled={busy}
          className="primary-btn"
        >
          Continue With Google
        </button>

        {showDevLogin ? (
          <form onSubmit={completeDevLogin} className="dev-form">
            <h2>Developer Quick Login</h2>
            <label>
              Email
              <input
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                required
              />
            </label>
            <label>
              Display Name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                type="text"
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              Dev Login
            </button>
          </form>
        ) : null}

        {error ? <p role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
