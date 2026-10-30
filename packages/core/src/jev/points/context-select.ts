/**
 * Multi-turn context fragment selection via Jev noul.
 * Keep/drop only — never rewrite part bodies. Failures return null.
 */

import type { MessagePart, SessionMessage as Message } from '../../types.js';
import { askJev, noulOf, type AskJevFn, type JevNoulQuestion } from '../client.js';
import type { JevChain } from '../settings.js';

const MIN_FRAGMENT_CHARS = 200;
const MAX_CANDIDATES = 8;
/** Drop only when Jev is confident the fragment is irrelevant. */
const RELEVANCE_DROP_BELOW = 0.35;
const PREVIEW_CHARS = 1_200;

type Fragment = {
  messageIndex: number;
  partIndex: number;
  content: string;
};

function partText(part: MessagePart): string | null {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return part.text;
    case 'tool_result':
      return part.content;
    case 'audio':
    case 'video':
    case 'image':
    case 'tool_call':
    case 'surface_update':
      return null;
    default: {
      const _exhaustive: never = part;
      return _exhaustive;
    }
  }
}

function isErrorToolResult(part: MessagePart): boolean {
  return part.type === 'tool_result' && part.ok === false;
}

/** Index of the start of the protected tail (last ≤2 user turns + trailing). */
function protectFromIndex(messages: Message[]): number {
  const userIdx: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') userIdx.push(i);
  }
  if (userIdx.length >= 2) return userIdx[userIdx.length - 2]!;
  if (userIdx.length === 1) return userIdx[0]!;
  // No user turns: keep the whole list as tail.
  return 0;
}

function collectEarlyFragments(messages: Message[], protectFrom: number): Fragment[] {
  const out: Fragment[] = [];
  for (let messageIndex = 0; messageIndex < protectFrom; messageIndex++) {
    const message = messages[messageIndex]!;
    message.parts.forEach((part, partIndex) => {
      if (isErrorToolResult(part)) return;
      const text = partText(part);
      if (text == null || text.length < MIN_FRAGMENT_CHARS) return;
      out.push({ messageIndex, partIndex, content: text });
    });
  }
  return out;
}

function rebuildMessages(
  messages: Message[],
  drop: ReadonlySet<string>
): Message[] {
  const next: Message[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    const parts: MessagePart[] = [];
    let changed = false;
    message.parts.forEach((part, partIndex) => {
      if (!drop.has(`${messageIndex}:${partIndex}`)) {
        parts.push(part);
        return;
      }
      changed = true;
      // Keep the tool_result shell so the matching tool_call stays paired.
      if (part.type === 'tool_result') {
        parts.push({
          ...part,
          content: '[jev-context] omitted as irrelevant to the current task'
        });
      }
    });
    if (parts.length === 0) continue;
    if (!changed) next.push(message);
    else next.push({ ...message, parts });
  }
  return next;
}

/**
 * Select relevant earlier context fragments with Jev; preserve the recent tail.
 * Returns null when the chain is unavailable or askJev fails (caller keeps original).
 */
export async function applyJevContextSelect(
  chain: JevChain | null | undefined,
  messages: Message[],
  taskText: string,
  ask: AskJevFn = askJev
): Promise<Message[] | null> {
  if (!chain) return null;

  const protectFrom = protectFromIndex(messages);
  const early = collectEarlyFragments(messages, protectFrom);
  if (early.length === 0) return messages;

  const overflow = early.length > MAX_CANDIDATES ? early.length - MAX_CANDIDATES : 0;
  const autoDrop = early.slice(0, overflow);
  const candidates = early.slice(overflow);

  const dropKeys = new Set<string>();
  for (const frag of autoDrop) {
    dropKeys.add(`${frag.messageIndex}:${frag.partIndex}`);
  }

  if (candidates.length === 0) {
    return dropKeys.size === 0 ? messages : rebuildMessages(messages, dropKeys);
  }

  const nouls: JevNoulQuestion[] = candidates.map((_, i) => ({
    id: `c${i}`,
    instructions:
      'Is this earlier conversation fragment relevant to the current task? ' +
      'Score higher only if it still helps complete the task.'
  }));

  const state = [
    `Current task:\n${taskText.slice(0, 4_000)}`,
    ...candidates.map(
      (frag, i) => `[#${i}]\n${frag.content.slice(0, PREVIEW_CHARS)}`
    )
  ].join('\n\n');

  const answers = await ask({ chain, point: 'contextSelect', state, nouls });
  if (!answers) return null;

  candidates.forEach((_, i) => {
    const p = noulOf(answers, `c${i}`);
    if (p != null && p < RELEVANCE_DROP_BELOW) {
      const frag = candidates[i]!;
      dropKeys.add(`${frag.messageIndex}:${frag.partIndex}`);
    }
  });

  if (dropKeys.size === 0) return messages;
  return rebuildMessages(messages, dropKeys);
}
