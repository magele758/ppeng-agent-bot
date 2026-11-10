'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { loginRequiredEventLocksLab } from '@/lib/api';
import { authErrorFromSearch, parseAuthMe, type AuthMeResponse, type AuthUser } from '@/lib/auth';
import { LoginScreen } from './LoginScreen';
import './auth.css';

async function loadLoginState(signal: AbortSignal) {
  const res = await fetch('/api/auth/me', { signal, cache: 'no-store' });
  if (!res.ok) throw new Error('Login check failed');
  const data = await res.json();
  if (typeof data?.loginRequired !== 'boolean') throw new Error('Invalid login response');
  return parseAuthMe(data);
}

export function AuthGate({
  children,
  onUser
}: {
  children: ReactNode;
  onUser?: (user: AuthUser | null) => void;
}) {
  const [me, setMe] = useState<AuthMeResponse | null>(null);
  const [error, setError] = useState<'denied' | 'failed' | undefined>();

  const [attempt, setAttempt] = useState(0);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.labMounted = '1';
    delete document.documentElement.dataset.bootFailed;
    setError(authErrorFromSearch(window.location.search));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    void loadLoginState(controller.signal)
      .then((data) => {
        if (cancelled) return;
        setMe(data);
        onUser?.(data.user);
      })
      .catch(() => {
        if (cancelled) return;
        setUnreachable(true);
      }).finally(() => clearTimeout(timeout));
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt, onUser]);

  useEffect(() => {
    const onRequired = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as { loginRequired?: boolean } | undefined) : undefined;
      if (!loginRequiredEventLocksLab(detail)) return;
      setMe((cur) =>
        cur ? { ...cur, loginRequired: true, user: null } : { loginRequired: true, providers: [], user: null }
      );
      onUser?.(null);
    };
    window.addEventListener('ppeng-login-required', onRequired);
    return () => window.removeEventListener('ppeng-login-required', onRequired);
  }, [onUser]);

  if (!me) return <LoginCheck unreachable={unreachable} retry={() => {
    setUnreachable(false);
    setAttempt(value => value + 1);
  }} />;
  if (me.loginRequired && !me.user) {
    return <LoginScreen me={me} error={error} />;
  }
  return <>{children}</>;
}

function LoginCheck({ unreachable, retry }: { unreachable: boolean; retry: () => void }) {
  const { t } = useI18n();
  if (unreachable) {
    return <div className="auth-gate__loading" role="alert">{t('auth.connectionFailed')}
      <button data-testid="auth-retry" onClick={retry}>{t('auth.retry')}</button>
    </div>;
  }
  return (
      <div className="auth-gate__loading" role="status" aria-live="polite">
        <span className="auth-spinner" aria-hidden="true" />
        <span data-boot-loading>{t('auth.loading')}</span>
        <span data-boot-error>{t('auth.bootFailed')}</span>
        <form method="get" data-auth-reload="">
          <input type="hidden" name="labRetry" value="1" />
          <button type="submit">{t('auth.reload')}</button>
        </form>
      </div>
  );
}
