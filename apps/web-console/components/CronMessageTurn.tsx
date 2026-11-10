'use client';

import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { BotEntryDialog } from './BotEntryDialog';

export function CronMessageTurn({ name, children }: { name: string; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = t('play.turns.cronTag', { name });
  return (
    <div className="chat-turn chat-turn--no-avatar cron-message-turn">
      <button type="button" className="btn btn-ghost btn-sm cron-message-trigger" aria-haspopup="dialog"
        aria-expanded={open} onClick={() => setOpen(true)}>
        <span>{label}</span><span aria-hidden="true">›</span>
      </button>
      {open && createPortal(
        <BotEntryDialog label={label}>
          <div className="bot-relay-dialog__body">{children}</div>
          <div className="bot-relay-dialog__actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>{t('common.close')}</button>
          </div>
        </BotEntryDialog>, document.body
      )}
    </div>
  );
}
