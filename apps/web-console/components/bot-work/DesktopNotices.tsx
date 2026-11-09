'use client';
import { useEffect, useRef, useState } from 'react';
import { desktopObserver, noticePermission, noticeSubscription, saveNoticeSubscription, type DesktopEvent } from '@/lib/desktop-notices';
import { useI18n } from '@/lib/i18n';
import { useLab } from '../shell/LabProvider';
import { SettingsGroup } from '../ui';

export function useDesktopNotices() {
  const { t } = useI18n();
  const { openSession, navigate } = useLab();
  const observer = useRef<ReturnType<typeof desktopObserver> | null>(null);
  const handle = useRef((_: unknown) => {});
  function show(event: DesktopEvent) {
    const title = t(event.kind === 'completed' ? 'settings.desktopNotices.completed' : 'settings.desktopNotices.interaction', { name: event.name });
    const notice = new Notification(title, { tag: event.tag });
    notice.onclick = () => {
      window.focus();
      notice.close();
      if (event.delegated || !event.sessionId) navigate('tasks', 'bots');
      else void openSession(event.sessionId, { focusChat: true });
    };
  }
  handle.current = snapshot => {
    observer.current ??= desktopObserver();
    const enabled = noticePermission() === 'granted' ? noticeSubscription() : '';
    for (const event of observer.current(snapshot, enabled)) {
      try { show(event); } catch { /* Notification transport can be disabled by the OS. */ }
    }
  };
  return handle;
}

function permissionBlocked(permission: string) {
  return permission === 'unavailable' || permission === 'denied';
}

export function DesktopNoticesCard() {
  const { t } = useI18n();
  const [permission, setPermission] = useState<ReturnType<typeof noticePermission>>('default');
  const [enabled, setEnabled] = useState(false);
  const [failed, setFailed] = useState(false);
  function refresh() {
    const current = noticePermission();
    setPermission(current);
    setEnabled(current === 'granted' && Boolean(noticeSubscription()));
  }
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener('focus', refresh); window.removeEventListener('storage', refresh); };
  }, []);
  async function toggle() {
    try {
      setFailed(false);
      const allow = !enabled && await Notification.requestPermission() === 'granted';
      saveNoticeSubscription(allow);
    } catch { setFailed(true); }
    refresh();
  }
  return <div className="card"><SettingsGroup title={t('settings.desktopNotices.title')} description={t('settings.desktopNotices.description')}>
    <button type="button" data-testid="desktop-notices-toggle" aria-pressed={enabled}
      disabled={permissionBlocked(permission)} onClick={() => void toggle()}>
      {t(enabled ? 'settings.desktopNotices.disable' : 'settings.desktopNotices.enable')}
    </button>
    {permission === 'denied' && <p role="status">{t('settings.desktopNotices.denied')}</p>}
    {permission === 'unavailable' && <p role="status">{t('settings.desktopNotices.unavailable')}</p>}
    {failed && <p role="status">{t('settings.desktopNotices.failed')}</p>}
  </SettingsGroup></div>;
}
