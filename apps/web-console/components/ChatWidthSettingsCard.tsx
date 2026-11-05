'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { applyChatWidth, readChatWidth } from '@/lib/chat-width';
import { preferenceStorage } from '@/lib/user-preference-storage';
import { usePreferenceRevision } from './usePreferenceRevision';
import { SettingsGroup } from './ui';

export function ChatWidthSettingsCard() {
  const { t } = useI18n();
  const revision = usePreferenceRevision();
  const [layout, setLayout] = useState({ mode: 'center', gap: 0 });
  useEffect(() => { setLayout(readChatWidth()); }, [revision]);
  function save(key: string, value: string) {
    preferenceStorage.setItem(key, value);
    applyChatWidth();
    setLayout(readChatWidth());
  }
  return <div className="card">
    <SettingsGroup title={t('settings.chatWidth.title')}>
      <div className="font-size-controls">
        <label htmlFor="chat-width-mode">{t('settings.chatWidth.mode')}</label>
        <select id="chat-width-mode" value={layout.mode} onChange={e => save('lab.chatWidth', e.target.value)}>
          <option value="center">{t('settings.chatWidth.center')}</option>
          <option value="full">{t('settings.chatWidth.full')}</option>
        </select>
        <label htmlFor="chat-width-gap">{t('settings.chatWidth.gap')}</label>
        <input type="range" id="chat-width-gap" min="0" max="96" value={layout.gap}
          onChange={e => save('lab.chatGutter', e.target.value)} />
        <output htmlFor="chat-width-gap">{t('settings.chatWidth.pixels', { value: layout.gap })}</output>
      </div>
    </SettingsGroup>
  </div>;
}
