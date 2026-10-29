'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { approveInit, draftActionError, editInit } from '@/lib/outbound-draft-preview';
import { EmptyState, SettingsGroup } from '../../ui';
import { useLab, type OutboundDraftItem } from '../../shell/LabProvider';
import { ListFallback } from './ListFallback';
import { OutboundDraftCard } from './OutboundDraftCard';
import styles from './tasks.module.css';

/** Draft → Confirm → Send inbox. Editing the preview never sends; a human still approves. */
export function OutboundDraftsPanel() {
  const { t } = useI18n();
  const { outboundDrafts, listState, tick } = useLab();
  const [loginHint, setLoginHint] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (request: Promise<unknown>): Promise<boolean> => {
    setLoginHint(false);
    setError(null);
    try {
      await request;
      return true;
    } catch (cause) {
      const failure = draftActionError(cause);
      setLoginHint(failure.loginRequired);
      setError(failure.loginRequired ? null : failure.message);
      return false;
    } finally {
      void tick();
    }
  };
  const save = (draft: OutboundDraftItem, text: string) =>
    run(api(`/api/outbound-drafts/${draft.id}`, editInit(draft, text)));
  const approve = (draft: OutboundDraftItem) => void run(api(`/api/outbound-drafts/${draft.id}/approve`, approveInit(draft)));
  const reject = (draft: OutboundDraftItem) => void run(api(`/api/outbound-drafts/${draft.id}/reject`, { method: 'POST' }));

  return (
    <SettingsGroup title={t('tasks.inbox.draftsTitle')} description={t('tasks.inbox.draftsDesc')}>
      {loginHint ? (
        <p id="outboundDraftLoginHint" className={styles.draftHint} role="alert">
          {t('tasks.inbox.loginRequiredToSend')}
        </p>
      ) : null}
      {error ? <p role="alert">{t('tasks.actionFailed', { error })}</p> : null}
      <ListFallback
        error={listState.outboundDrafts.error}
        count={outboundDrafts.length}
        empty={<EmptyState title={t('tasks.inbox.draftsEmptyTitle')} description={t('tasks.inbox.draftsEmptyDesc')} />}
      >
        <div id="listOutboundDrafts" className={styles.list}>
          {outboundDrafts.map((draft) => (
            <OutboundDraftCard key={draft.id} draft={draft} onSave={save} onApprove={approve} onReject={reject} />
          ))}
        </div>
      </ListFallback>
    </SettingsGroup>
  );
}
