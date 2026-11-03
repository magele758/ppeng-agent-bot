'use client';

import { createContext, useContext, useRef, useState } from 'react';
import type { ChatMessage } from '@/lib/types';
import { useI18n } from '@/lib/i18n';
import { userMessageText } from '@/lib/user-message-actions';
import './UserMessageActions.css';

export const UserMessageActionsContext = createContext<{
  retry: (sessionId: string, message: ChatMessage) => Promise<void>;
  busy: boolean;
} | null>(null);

export function UserMessageActions({ message, sessionId, modelView }: { message: ChatMessage; sessionId: string; modelView: boolean }) {
  const actions = useContext(UserMessageActionsContext);
  if (message.role !== 'user' || modelView) return null;
  if (!actions || !sessionId) return null;
  return <MessageActionMenu message={message} sessionId={sessionId} actions={actions} />;
}

function MessageActionMenu({ message, sessionId, actions }: {
  message: ChatMessage;
  sessionId: string;
  actions: NonNullable<React.ContextType<typeof UserMessageActionsContext>>;
}) {
  const { t } = useI18n();
  const menu = useRef<HTMLDetailsElement>(null);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(userMessageText(message)); setNotice(t('play.userActions.copied')); }
    catch { setNotice(t('play.userActions.copyFailed')); }
  };
  const retry = async () => {
    setPending(true);
    setNotice('');
    try { await actions.retry(sessionId, message); }
    catch { setNotice(t('play.userActions.retryFailed')); }
    finally { setPending(false); }
  };
  return <details className="user-message-actions" ref={menu} onKeyDown={event => {
    if (event.key === 'Escape' && menu.current) menu.current.open = false;
  }}>
    <summary aria-label={t('play.userActions.menu')} title={t('play.userActions.menu')}>···</summary>
    <div className="user-message-actions__menu" aria-label={t('play.userActions.menu')}>
      <button type="button" onClick={() => void copy()}>{t('play.userActions.copy')}</button>
      <button type="button" disabled={actions.busy || pending} onClick={() => void retry()} title={t('play.userActions.retryHint')}>{t('play.userActions.retry')}</button>
      <span role="status">{notice}</span>
    </div>
  </details>;
}
