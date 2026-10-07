import type { ReactElement } from 'react';
import { useState } from 'react';
import { api, ApiFailure } from '../lib/api.ts';
import { t } from '../lib/i18n.ts';

export function SignIn({ onSignedIn }: { onSignedIn: () => void }): ReactElement {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="auth"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void api
          .login(password)
          .then(onSignedIn)
          .catch((failure: unknown) => {
            // The lockout is a different answer from a wrong password, and saying so is the
            // difference between "try again" and "wait".
            setError(
              failure instanceof ApiFailure && failure.status === 429 ? t('auth.locked') : t('auth.failed'),
            );
          })
          .finally(() => setBusy(false));
      }}
    >
      <h1>{t('auth.title')}</h1>
      <label>
        {t('auth.password')}
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          style={{ width: '100%' }}
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <button className="primary" type="submit" disabled={busy || password === ''}>
        {t('auth.submit')}
      </button>
    </form>
  );
}
