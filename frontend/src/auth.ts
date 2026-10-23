import { useEffect, useState } from 'react';
import { ApiError, authorizedJson } from './api';
import { getTelegramInitData, onReturn } from './telegram';

export type CurrentUser = { telegramId: string; role: 'Customer' | 'Admin' };

export function useTelegramUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<'guest' | 'loading' | 'ready' | 'expired' | 'forbidden' | 'error'>('guest');
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let controller = new AbortController();
    /** `quiet`: a recheck on return to the app keeps the current screen (and any open form) until the answer. */
    function initialize(quiet = false) {
      // Aborting the previous check means its late answer can never overwrite a newer one.
      controller.abort();
      controller = new AbortController();
      if (!getTelegramInitData()) { setUser(null); setStatus('guest'); return; }
      const active = controller;
      if (!quiet) setStatus('loading');
      authorizedJson<CurrentUser>('/api/auth/telegram', 'POST', undefined, active.signal).then(value => {
        if (!active.signal.aborted) { setUser(value); setError(null); setStatus('ready'); }
      }).catch(error => {
        if (!active.signal.aborted) {
          setError(error instanceof ApiError ? error : null);
          // A connection failure cannot revoke the last server-confirmed role.
          // Every protected API request still checks the current role on the server.
          if (error instanceof ApiError && (error.status === 401 || error.status === 403)) setUser(null);
          setStatus(error instanceof ApiError && error.status === 401 ? 'expired'
            : error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error');
        }
      });
    }
    const expired = () => { setUser(null); setStatus('expired'); };
    const forbidden = () => { setUser(null); setStatus('forbidden'); };
    const load = () => initialize();
    let stopReturn = () => {};
    // The SDK script is async: listen for the return once it has loaded, and again after 'load'.
    const listenReturn = () => { stopReturn(); stopReturn = onReturn(() => initialize(true)); };
    initialize(); listenReturn();
    window.addEventListener('load', load);
    window.addEventListener('load', listenReturn);
    window.addEventListener('telegram-auth-expired', expired);
    window.addEventListener('telegram-access-denied', forbidden);
    return () => {
      controller.abort(); stopReturn();
      window.removeEventListener('load', load); window.removeEventListener('load', listenReturn);
      window.removeEventListener('telegram-auth-expired', expired);
      window.removeEventListener('telegram-access-denied', forbidden);
    };
  }, [attempt]);
  return { user, status, error, retry: () => setAttempt(value => value + 1) };
}
