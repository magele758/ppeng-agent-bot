'use client';

import { useI18n } from '@/lib/i18n';
import { SessionBriefToggle } from './SessionBriefToggle';
import { SettingsGroup } from './ui';

export function SessionBriefSettingsCard() {
  const { t } = useI18n();
  return (
    <div className="card" id="card-session-brief">
      <SettingsGroup title={t('settings.sessionBrief.title')} description={t('settings.sessionBrief.description')}>
        <SessionBriefToggle />
      </SettingsGroup>
    </div>
  );
}
