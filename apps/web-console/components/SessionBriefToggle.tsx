'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { applySessionBrief, readSessionBrief, SESSION_BRIEF_CHANGED_EVENT } from '@/lib/session-brief';

export function SessionBriefToggle({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const [on, setOn] = useState(true);
  useEffect(() => {
    const sync = () => setOn(readSessionBrief());
    sync();
    window.addEventListener(SESSION_BRIEF_CHANGED_EVENT, sync);
    return () => window.removeEventListener(SESSION_BRIEF_CHANGED_EVENT, sync);
  }, []);
  return (
    <label className={compact ? 'toggle toggle--compact more-menu__item' : 'toggle'} title={t('play.chrome.sessionBriefTitle')}>
      <input
        type="checkbox"
        checked={on}
        onChange={(event) => applySessionBrief(event.target.checked)}
        aria-label={t('play.chrome.sessionBriefAria')}
      />
      <span>{t('play.sessionBrief')}</span>
    </label>
  );
}
