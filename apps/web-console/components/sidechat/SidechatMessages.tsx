'use client';
import { useEffect, useRef } from 'react';
import type { SidechatMessage, SidechatThread } from '@ppeng/api-types';
import { useI18n } from '@/lib/i18n';
import type { SidechatDetail } from '@/lib/sidechat-api';
import { MarkdownHtml } from '../MarkdownHtml';
import { ReplyActions } from './learning-tools';

export function SidechatMessages({
  messages,
  hit,
  author,
  onCite
}: {
  messages: SidechatMessage[];
  hit?: string;
  author: string;
  onCite?: (text: string) => void;
}) {
  const { t } = useI18n();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hit) return;
    const msg = Array.from(list.current?.children ?? []).find((el) => el.getAttribute('data-message') === hit);
    const scroller = list.current?.closest<HTMLElement>('[data-sidechat-scroll]');
    if (!msg || !scroller) return;
    scroller.scrollTop += msg.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
  }, [hit, messages.length]);
  return (
    <div ref={list} className="sc-messages">
      {messages.map((m) => (
        <article key={m.id} data-message={m.id} data-role={m.role} data-hit={m.id === hit}>
          <small>{m.role === 'user' ? t('sidechat.you') : author}</small>
          <MessageBody message={m} />
          <ReplyActions message={m} onCite={onCite} />
        </article>
      ))}
    </div>
  );
}
function MessageBody({ message }: { message: SidechatMessage }) {
  if (message.role === 'user') return <p>{message.text}</p>;
  if (!message.text) return null;
  return <MarkdownHtml className="chat-bubble__md" text={message.text} />;
}

export function Loading() {
  const { t } = useI18n();
  return (
    <p role="status" className="sc-note">
      {t('sidechat.loading')}
    </p>
  );
}
export function LoadError({ retry }: { retry: () => void }) {
  const { t } = useI18n();
  return (
    <p role="alert" className="sc-error">
      {t('sidechat.loadError')}{' '}
      <button type="button" onClick={retry}>
        {t('sidechat.retry')}
      </button>
    </p>
  );
}

export function SourceLink({
  detail,
  onOpen,
  crossSession = false
}: {
  detail: SidechatDetail;
  onOpen: (thread: SidechatThread) => void;
  crossSession?: boolean;
}) {
  const { t } = useI18n();
  if (detail.sourceAvailable === false) return <small role="status">{t('sidechat.sourceUnavailable')}</small>;
  return (
    <button type="button" className="sc-button" onClick={() => onOpen(detail.thread)}>
      {t(crossSession ? 'sidechat.openSource' : 'sidechat.locate')}
    </button>
  );
}
