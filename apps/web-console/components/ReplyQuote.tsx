'use client';

import { useI18n } from '@/lib/i18n';
import { quoteFromReply, type QuoteableReply, type ReplyQuote, type ReplyTo } from '@/lib/reply-quote';

export function ReplyQuoteButton({
  messageId,
  label,
  ariaLabel,
  onQuote
}: {
  messageId: string;
  label: string;
  ariaLabel: string;
  onQuote: () => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm chat-reply-quote__start"
      data-testid="reply-quote-start"
      data-message-id={messageId}
      aria-label={ariaLabel}
      onClick={onQuote}
    >
      {label}
    </button>
  );
}

export function BotReplyQuoteAction({
  reply,
  onQuote
}: {
  reply: QuoteableReply;
  onQuote: (quote: ReplyQuote) => void;
}) {
  const { t } = useI18n();
  const quote = quoteFromReply(reply);
  if (!quote) return null;
  return (
    <ReplyQuoteButton
      messageId={quote.messageId}
      label={t('play.replyQuote.action')}
      ariaLabel={t('play.replyQuote.actionAria', { name: quote.botName })}
      onQuote={() => onQuote(quote)}
    />
  );
}

export function ComposerReplyQuote({
  quote,
  onCancel,
  surface
}: {
  quote: ReplyQuote | null;
  onCancel: () => void;
  surface: 'direct' | 'group';
}) {
  const { t } = useI18n();
  if (!quote) return null;
  return (
    <div
      className="composer-reply-quote"
      data-testid="composer-reply-quote"
      data-surface={surface}
      data-message-id={quote.messageId}
      data-bot-id={quote.botId}
    >
      <span className="composer-reply-quote__who">{t('play.replyQuote.quoting', { name: quote.botName })}</span>
      <span className="composer-reply-quote__excerpt">{quote.excerpt}</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm composer-reply-quote__cancel"
        data-testid="composer-reply-quote-cancel"
        aria-label={t('play.replyQuote.cancel')}
        onClick={onCancel}
      >
        {t('play.replyQuote.cancel')}
      </button>
    </div>
  );
}

export function MessageReplyQuote({ replyTo, botName }: { replyTo: ReplyTo | null; botName?: string }) {
  const { t } = useI18n();
  if (!replyTo) return null;
  const who = botName?.trim() || replyTo.botId;
  return (
    <blockquote
      className="chat-reply-quote"
      data-testid="message-reply-quote"
      data-message-id={replyTo.messageId}
      data-bot-id={replyTo.botId}
    >
      <span className="chat-reply-quote__who">{t('play.replyQuote.from', { name: who })}</span>
      <span className="chat-reply-quote__excerpt">{replyTo.excerpt}</span>
    </blockquote>
  );
}
