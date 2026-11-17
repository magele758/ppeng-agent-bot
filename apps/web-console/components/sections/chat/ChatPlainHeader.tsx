'use client';

import { useI18n } from '@/lib/i18n';
import { chatQuietLine } from '@/lib/chat-page-redesign';

export function ChatPlainHeaderStatus({
  botSurface,
  hasSession,
  agentId,
  agentName,
  status
}: {
  botSurface: boolean;
  hasSession: boolean;
  agentId: string;
  agentName: string;
  status?: string;
}) {
  const { t } = useI18n();
  const line = chatQuietLine({ botSurface, hasSession, agentId, agentName, status }, t);
  if (!line) return null;
  return <p className="chat-panel-header__quiet" data-testid="chat-quiet-status">{line}</p>;
}
