'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n, type MessageKey } from '@/lib/i18n';
import type { BotRelayMessage } from '@/lib/bot-relay-message';
import { BotEntryDialog } from './BotEntryDialog';
import { MarkdownHtml } from './MarkdownHtml';
import './BotRelayStrip.css';

const RESULT_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function statusKey(status: string | undefined): MessageKey {
  const known = status && RESULT_STATUSES.has(status) ? status : 'unknown';
  return `play.botRelay.status.${known}` as MessageKey;
}

function useKindLabel(relay: BotRelayMessage): string {
  const { t } = useI18n();
  const kind = t(`play.botRelay.kind.${relay.kind}` as MessageKey);
  return relay.kind === 'result' ? `${kind} · ${t(statusKey(relay.status))}` : kind;
}

export function BotRelayDialog({ relay, onClose }: { relay: BotRelayMessage; onClose: () => void }) {
  const { t } = useI18n();
  const kind = useKindLabel(relay);
  return (
    <BotEntryDialog label={t('play.botRelay.dialog', { name: relay.senderName })}>
      <div className="bot-relay-dialog__head">
        <strong>{relay.senderName}</strong>
        <span className="bot-relay-strip__kind">{kind}</span>
      </div>
      <MarkdownHtml className="bot-relay-dialog__body chat-bubble__md" text={relay.text} />
      <div className="bot-relay-dialog__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('play.botRelay.close')}</button>
      </div>
    </BotEntryDialog>
  );
}

/** One-line stand-in for Bot-to-Bot traffic; the full text opens in a dialog. */
export function BotRelayTurn({ relay }: { relay: BotRelayMessage }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const kind = useKindLabel(relay);
  return (
    <div className="chat-turn chat-turn--no-avatar bot-relay-turn">
      <button
        type="button"
        className="bot-relay-strip"
        data-testid="bot-relay-strip"
        aria-haspopup="dialog"
        aria-label={t('play.botRelay.open', { name: relay.senderName })}
        onClick={() => setOpen(true)}
      >
        <span className="bot-relay-strip__line">
          <span className="bot-relay-strip__from">{t('play.botRelay.from')}</span>
          <span className="bot-relay-strip__avatar" aria-hidden="true">{Array.from(relay.senderName)[0]}</span>
          <span className="bot-relay-strip__name">{relay.senderName}</span>
        </span>
        <span className="bot-relay-strip__line">
          <span className="bot-relay-strip__kind">{kind}</span>
          <span className="bot-relay-strip__summary">{relay.summary}</span>
        </span>
      </button>
      {open ? createPortal(<BotRelayDialog relay={relay} onClose={() => setOpen(false)} />, document.body) : null}
    </div>
  );
}
