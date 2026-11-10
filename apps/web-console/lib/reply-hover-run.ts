import type { FeedSlot } from './feed-window';
import type { ChatMessage } from './types';
import { replySourceText } from './reply-quote';
import { visibleBriefParts } from './session-brief';
import { quietRoutineResult } from './routine-quiet';
import { parseBotRelayMessage } from './bot-relay-message';

export interface ReplyRun {
  first: number;
  last: ChatMessage;
  text: string;
}

function replyText(message: ChatMessage & { key?: string }, brief: boolean): string {
  const parts = brief ? visibleBriefParts(message.parts) : message.parts;
  const text = replySourceText(parts);
  if (quietRoutineResult('assistant', message.key, text)) return '';
  if (parseBotRelayMessage('assistant', text)) return '';
  return text;
}

function belongsToReply(slot: FeedSlot, message?: ChatMessage): boolean {
  if (['brief-note', 'approval', 'child-task'].includes(slot.kind)) return !slot.pin;
  if (slot.kind !== 'message') return false;
  return message?.role === 'assistant' || message?.role === 'tool';
}

function assistantPart(slot: FeedSlot, messages: ChatMessage[], brief: boolean) {
  const index = slot.messageIndex;
  if (index == null || slot.kind !== 'message') return;
  const message = messages[index];
  if (message?.role !== 'assistant') return;
  const text = replyText(message, brief);
  if (text.trim()) return { index, text };
}

/** Keep the original rows and their controls, but give one answer one hover target. */
export function groupReplySlots(slots: FeedSlot[], messages: ChatMessage[], brief: boolean, botSurface: boolean): FeedSlot[] {
  if (!botSurface) return slots;
  const out: FeedSlot[] = [];
  let run: FeedSlot[] = [];
  let prose: { index: number; text: string }[] = [];
  const flush = () => {
    if (prose.length < 2) out.push(...run);
    else {
      const first = prose[0]!.index;
      const last = messages[prose[prose.length - 1]!.index]!;
      out.push({ key: run[0]!.key, kind: 'reply-run', folded: run,
        replyRun: { first, last, text: prose.map(part => part.text).join('\n\n') } });
    }
    run = [];
    prose = [];
  };
  for (const slot of slots) {
    const index = slot.messageIndex ?? -1;
    const message = messages[index];
    if (!belongsToReply(slot, message)) {
      flush();
      out.push(slot);
      continue;
    }
    run.push(slot);
    const part = assistantPart(slot, messages, brief);
    if (part) prose.push(part);
  }
  flush();
  return out;
}
