import { useEffect, useState } from 'react';
import { ApiError, authorizedJson } from './api';
import { getTelegramInitData } from './telegram';

export type CurrentUser = { telegramId: string; role: 'Customer' | 'Admin' };

export function useTelegramUser() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [status, setStatus] = useState<'guest' | 'loading' | 'ready' | 'expired' | 'forbidden' | 'error'>('guest');
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let controller = new AbortController();
    function initialize() {
      controller.abort();
      controller = new AbortController();
      if (!getTelegramInitData()) { setUser(null); setStatus('guest'); return; }
      const active = controller;
      setStatus('loading');
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
    initialize();
    window.addEventListener('load', initialize);
    window.addEventListener('telegram-auth-expired', expired);
    window.addEventListener('telegram-access-denied', forbidden);
    return () => {
      controller.abort(); window.removeEventListener('load', initialize);
      window.removeEventListener('telegram-auth-expired', expired);
      window.removeEventListener('telegram-access-denied', forbidden);
    };
  }, [attempt]);
  return { user, status, error, retry: () => setAttempt(value => value + 1) };
}
