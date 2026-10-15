import type { SessionMessage } from '../types.js';

export interface FoldTextStore {
  foldMessages(sessionId: string): SessionMessage[];
}

function textOf(message: SessionMessage): string {
  let text = '';
  for (const part of message.parts) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function startAfter(messages: SessionMessage[], afterId: string | undefined): number {
  if (!afterId) return 0;
  return messages.findIndex((message) => message.id === afterId) + 1;
}

/** Assistant text from the folded model view. Hidden and replaced rows stay out. */
export function assistantTextsFromFold(store: FoldTextStore, sessionId: string, afterId?: string): string[] {
  const folded = store.foldMessages(sessionId);
  const texts: string[] = [];
  for (const message of folded.slice(startAfter(folded, afterId))) {
    if (message.role !== 'assistant') continue;
    const text = textOf(message);
    if (!text) continue;
    texts.push(text);
  }
  return texts;
}
