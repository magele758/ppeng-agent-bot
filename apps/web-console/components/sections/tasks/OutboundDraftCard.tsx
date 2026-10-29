'use client';

import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  canApproveDraft,
  canSaveDraftText,
  identityKindKey,
  isDraftEditable,
  type OutboundIdentity
} from '@/lib/outbound-draft-preview';
import type { OutboundDraftItem } from '../../shell/LabProvider';
import styles from './tasks.module.css';

/** Who the message goes out as. Non-secret handles only. */
export function OutboundIdentityBar({ identity }: { identity: OutboundIdentity }) {
  const { t } = useI18n();
  return (
    <div className={styles.identityBar} data-testid="outbound-identity" data-resolved={identity.resolved}>
      <strong>{t('tasks.inbox.identityTitle')}</strong>
      <span>{t(identityKindKey(identity.kind))}</span>
      <span>
        {identity.sender
          ? t('tasks.inbox.identitySender', { sender: identity.sender })
          : t('tasks.inbox.identityNoSender')}
      </span>
      {identity.recipient ? <span>{t('tasks.inbox.identityRecipient', { recipient: identity.recipient })}</span> : null}
      {identity.resolved ? null : (
        <span className={styles.identityWarn} role="alert">
          {t('tasks.inbox.identityUnresolved')}
        </span>
      )}
    </div>
  );
}

function DraftMeta({ draft }: { draft: OutboundDraftItem }) {
  const { t } = useI18n();
  return (
    <div className={styles.rowMeta}>
      <span>{t('tasks.inbox.draftChannel', { channel: draft.channelId })}</span>
      {draft.event ? <span>{t('tasks.inbox.draftEvent', { event: draft.event })}</span> : null}
      {draft.revision ? <span>{t('tasks.inbox.editedBadge')}</span> : null}
      {draft.error ? <span>{draft.error}</span> : null}
    </div>
  );
}

export interface DraftBodyProps {
  draft: OutboundDraftItem;
  editing: boolean;
  value: string;
  onChange: (value: string) => void;
}

export function OutboundDraftBody({ draft, editing, value, onChange }: DraftBodyProps) {
  const { t } = useI18n();
  if (!editing) {
    return (
      <>
        <div className={styles.draftText}>{draft.text}</div>
        {draft.revision ? <small>{t('tasks.inbox.editedHint')}</small> : null}
      </>
    );
  }
  return (
    <>
      <textarea
        className={styles.draftEditor}
        aria-label={t('tasks.inbox.draftTextAria', { channel: draft.channelId })}
        value={value}
        rows={6}
        onChange={(event) => onChange(event.target.value)}
      />
      <small role="status">{t('tasks.inbox.unsavedEditHint')}</small>
    </>
  );
}

export interface DraftActionsProps {
  draft: OutboundDraftItem;
  editing: boolean;
  canSave: boolean;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  onApprove: () => void;
  onReject: () => void;
}

export function OutboundDraftActions(props: DraftActionsProps) {
  const { t } = useI18n();
  const { draft, editing } = props;
  if (draft.status === 'sending') return null;
  return (
    <div className={styles.actions}>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        aria-label={t('tasks.inbox.approveSendAria', { channel: draft.channelId })}
        disabled={!canApproveDraft(editing)}
        onClick={props.onApprove}
      >
        {t('tasks.inbox.approveSend')}
      </button>
      {editing ? (
        <>
          <button type="button" className="btn btn-sm" disabled={!props.canSave} onClick={props.onSave}>
            {t('tasks.inbox.saveDraft')}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={props.onCancel}>
            {t('tasks.inbox.cancelEdit')}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          aria-label={t('tasks.inbox.editDraftAria', { channel: draft.channelId })}
          disabled={!isDraftEditable(draft.status)}
          onClick={props.onEdit}
        >
          {t('tasks.inbox.editDraft')}
        </button>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-label={t('tasks.inbox.rejectDraftAria', { channel: draft.channelId })}
        onClick={props.onReject}
      >
        {t('tasks.inbox.rejectDraft')}
      </button>
    </div>
  );
}

export interface OutboundDraftCardProps {
  draft: OutboundDraftItem;
  /** Resolves true when the edit was saved. */
  onSave: (draft: OutboundDraftItem, text: string) => Promise<boolean>;
  onApprove: (draft: OutboundDraftItem) => void;
  onReject: (draft: OutboundDraftItem) => void;
}

/** One pending outbound draft: identity bar, editable preview, and the confirm/send actions. */
export function OutboundDraftCard({ draft, onSave, onApprove, onReject }: OutboundDraftCardProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(draft.text);
  const startEdit = () => {
    setValue(draft.text);
    setEditing(true);
  };
  const save = async () => {
    if (await onSave(draft, value)) setEditing(false);
  };
  return (
    <div className={`list-item ${styles.row}`} data-draft-id={draft.id}>
      <div className={styles.rowMain}>
        <strong>{draft.channelId}</strong>
        <span className={styles.status}>{draft.status}</span>
      </div>
      {draft.identity ? <OutboundIdentityBar identity={draft.identity} /> : null}
      <DraftMeta draft={draft} />
      <OutboundDraftBody draft={draft} editing={editing} value={value} onChange={setValue} />
      <OutboundDraftActions
        draft={draft}
        editing={editing}
        canSave={canSaveDraftText(draft, value)}
        onEdit={startEdit}
        onSave={() => void save()}
        onCancel={() => setEditing(false)}
        onApprove={() => onApprove(draft)}
        onReject={() => onReject(draft)}
      />
    </div>
  );
}
