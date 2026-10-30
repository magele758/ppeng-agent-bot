import { isToolObservationCaption } from './chat-images.ts';

export const SESSION_BRIEF_STORAGE_KEY = 'lab.sessionBrief';
export const SESSION_BRIEF_CHANGED_EVENT = 'ppeng-session-brief-changed';
export const SESSION_BRIEF_OPEN_KEY = 'lab.sessionBriefOpen';

const PROCESS_PART: Record<string, true> = {
  tool_call: true,
  tool_result: true,
  reasoning: true,
  surface_update: true
};

const COLLAPSE_KIND: Record<string, true> = {
  stats: true,
  'child-task': true
};

export function parseSessionBrief(raw: string | null | undefined): boolean {
  return raw !== '0';
}

export function readSessionBrief(): boolean {
  try {
    return parseSessionBrief(window.localStorage.getItem(SESSION_BRIEF_STORAGE_KEY));
  } catch {
    return true;
  }
}

/** Display preference only. Does not rewrite stored messages. */
export function applySessionBrief(on: boolean): boolean {
  try {
    window.localStorage.setItem(SESSION_BRIEF_STORAGE_KEY, on ? '1' : '0');
    window.dispatchEvent(new Event(SESSION_BRIEF_CHANGED_EVENT));
    return true;
  } catch {
    return false;
  }
}

export function parseBriefOpen(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

export function readBriefOpen(noteKey: string): boolean {
  try {
    return parseBriefOpen(window.localStorage.getItem(SESSION_BRIEF_OPEN_KEY)).includes(noteKey);
  } catch {
    return false;
  }
}

/** Display preference only. Does not rewrite stored messages. */
export function writeBriefOpen(noteKey: string, open: boolean): boolean {
  try {
    const keys = new Set(parseBriefOpen(window.localStorage.getItem(SESSION_BRIEF_OPEN_KEY)));
    if (open) keys.add(noteKey);
    else keys.delete(noteKey);
    window.localStorage.setItem(SESSION_BRIEF_OPEN_KEY, JSON.stringify([...keys]));
    return true;
  } catch {
    return false;
  }
}
export interface BriefPart {
  type: string;
  text?: string;
  assetId?: string;
  content?: string;
}

export interface BriefMessage {
  role?: string;
  parts?: BriefPart[];
}

export function visibleBriefParts<T extends BriefPart>(parts: readonly T[] | undefined): T[] {
  return (parts ?? []).filter((part) => {
    if (part.type === 'image') return Boolean(part.assetId?.trim());
    if (part.type !== 'text') return false;
    return !isToolObservationCaption(part.text) && Boolean((part.text ?? '').trim());
  });
}

export function briefMessageClass(message: BriefMessage | undefined): 'prose' | 'process' | 'noise' {
  if (!message) return 'noise';
  if (message.role === 'tool') return 'process';
  const parts = message.parts ?? [];
  const raw = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
  if (message.role === 'system') {
    return raw.trimStart().startsWith('[goal update]') ? 'prose' : 'noise';
  }
  const visible = visibleBriefParts(parts);
  if (message.role === 'user' || visible.length > 0) return 'prose';
  if (parts.some((part) => PROCESS_PART[part.type] || (part.type === 'text' && isToolObservationCaption(part.text)))) {
    return 'process';
  }
  return 'noise';
}

export interface BriefSlot {
  key: string;
  kind: string;
  messageIndex?: number;
}

export type BriefFeedRow<T extends BriefSlot> =
  | { type: 'slot'; slot: T }
  | { type: 'note'; key: string; count: number; slots: T[] };

function collapses(slot: BriefSlot, messages: readonly BriefMessage[]): boolean {
  if (COLLAPSE_KIND[slot.kind]) return true;
  return slot.kind === 'message' && briefMessageClass(messages[slot.messageIndex ?? -1]) !== 'prose';
}

export function rowsForSessionBrief<T extends BriefSlot>(
  on: boolean,
  slots: readonly T[],
  messages: readonly BriefMessage[]
): Array<BriefFeedRow<T>> {
  if (!on) return slots.map((slot) => ({ type: 'slot', slot }));
  const out: Array<BriefFeedRow<T>> = [];
  let run: T[] = [];
  const flush = () => {
    const first = run[0];
    if (!first) return;
    out.push({ type: 'note', key: `brief:${first.key}`, count: run.length, slots: run });
    run = [];
  };
  for (const slot of slots) {
    if (collapses(slot, messages)) {
      run.push(slot);
      continue;
    }
    flush();
    out.push({ type: 'slot', slot });
  }
  flush();
  return out;
}

/** 精简模式下被收起的过程完全不渲染；非精简模式有内容才渲染。 */
export function showProcessNote(brief: boolean, count: number): boolean {
  return !brief && count > 0;
}

export function briefStreamSegments<T extends { kind: string }>(segments: readonly T[]): { segments: T[]; hidden: T[] } {
  const kept: T[] = [];
  const hidden: T[] = [];
  for (const segment of segments) {
    if (segment.kind === 'text' || segment.kind === 'a2ui') kept.push(segment);
    else hidden.push(segment);
  }
  return { segments: kept, hidden };
}
