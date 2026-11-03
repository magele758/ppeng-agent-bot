import { stripVisibleClockMarks } from './visible-clock.ts';
import type { ChatMessage } from './types.ts';
import { readStoredReplyTo } from './reply-quote.ts';

export function userMessageText(message: ChatMessage): string {
  return stripVisibleClockMarks(message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n'));
}

export function retryMessageBody(message: ChatMessage) {
  return {
    message: userMessageText(message),
    imageAssetIds: message.parts.filter(part => part.type === 'image').map(part => part.assetId),
    attachmentIds: [],
    replyTo: readStoredReplyTo(message) ?? undefined
  };
}

export function messageRetryBusy(sending: boolean, status?: string, sharedStatus?: string): boolean {
  return sending || [status, sharedStatus].some(value => value === 'running' || value === 'waiting_approval');
}

type RetryPorts = {
  lock: { current: boolean };
  selected: () => string | null;
  busy: () => boolean;
  run: (sessionId: string, message: ChatMessage) => Promise<void>;
};

export async function runMessageRetry(ports: RetryPorts, sessionId: string, message: ChatMessage): Promise<void> {
  if (ports.lock.current || ports.busy()) return;
  if (ports.selected() !== sessionId) return;
  ports.lock.current = true;
  try { await ports.run(sessionId, message); }
  finally { ports.lock.current = false; }
}
