import type { FeedSlot } from './feed-window.ts';
import type { ChatMessage } from './types.ts';
import { replySourceText } from './reply-quote.ts';
import { visibleBriefParts } from './session-brief.ts';
import { quietRoutineResult } from './routine-quiet.ts';
import { parseBotRelayMessage } from './bot-relay-message.ts';

export interface ReplyRun {
  first: number;
  end: number;
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

/** Keep each segment, but attach one action row to the last prose of a whole answer. */
export function groupReplySlots(slots: FeedSlot[], messages: ChatMessage[], brief: boolean): FeedSlot[] {
  const out: FeedSlot[] = [];
  let run: FeedSlot[] = [];
  let prose: { index: number; text: string }[] = [];
  const flush = () => {
    if (prose.length < 2) out.push(...run);
    else {
      const first = prose[0]!.index;
      const end = prose[prose.length - 1]!.index;
      const last = messages[end]!;
      out.push({ key: run[0]!.key, kind: 'reply-run', folded: run,
        replyRun: { first, end, last, text: prose.map(part => part.text).join('\n\n') } });
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
