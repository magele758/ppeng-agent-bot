import { isSkillLoadPart } from './skill-load-label.ts';
import { preferenceStorage } from './user-preference-storage.ts';
import { isToolObservationCaption } from './chat-images.ts';
import { stripLeakedMonologue } from './leaked-monologue.ts';

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
    return parseSessionBrief(preferenceStorage.getItem(SESSION_BRIEF_STORAGE_KEY));
  } catch {
    return true;
  }
}

/** Display preference only. Does not rewrite stored messages. */
export function applySessionBrief(on: boolean): boolean {
  try {
    preferenceStorage.setItem(SESSION_BRIEF_STORAGE_KEY, on ? '1' : '0');
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
    return parseBriefOpen(preferenceStorage.getItem(SESSION_BRIEF_OPEN_KEY)).includes(noteKey);
  } catch {
    return false;
  }
}

/** Display preference only. Does not rewrite stored messages. */
export function writeBriefOpen(noteKey: string, open: boolean): boolean {
  try {
    const keys = new Set(parseBriefOpen(preferenceStorage.getItem(SESSION_BRIEF_OPEN_KEY)));
    if (open) keys.add(noteKey);
    else keys.delete(noteKey);
    preferenceStorage.setItem(SESSION_BRIEF_OPEN_KEY, JSON.stringify([...keys]));
    return true;
  } catch {
    return false;
  }
}
export interface BriefPart {
  type: string;
  name?: string;
  text?: string;
  assetId?: string;
  content?: string;
}

export interface BriefMessage {
  role?: string;
  parts?: BriefPart[];
}

function briefTextPart<T extends BriefPart>(part: T): T[] {
  if (isToolObservationCaption(part.text)) return [];
  const text = stripLeakedMonologue(part.text ?? '');
  if (!text.trim()) return [];
  return text === part.text ? [part] : [{ ...part, text }];
}

export function visibleBriefParts<T extends BriefPart>(parts: readonly T[] | undefined): T[] {
  return (parts ?? []).flatMap(visibleBriefPart);
}

export function briefMessageClass(message: BriefMessage | undefined): 'prose' | 'process' | 'noise' {
  if (!message) return 'noise';
  if (message.role === 'tool') return briefToolMessageClass(message);
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

export function briefStreamSegments<T extends { kind: string; name?: string }>(segments: readonly T[]): { segments: T[]; hidden: T[] } {
  const kept: T[] = [];
  const hidden: T[] = [];
  for (const segment of segments) {
    if (keepsBriefSegment(segment)) kept.push(segment);
    else hidden.push(segment);
  }
  return { segments: kept, hidden };
}

function visibleBriefPart<T extends BriefPart>(part: T): T[] {
  return isSkillLoadPart(part) ? [part] : ordinaryBriefPart(part);
}

function ordinaryBriefPart<T extends BriefPart>(part: T): T[] {
  if (part.type === 'image') return part.assetId?.trim() ? [part] : [];
  if (part.type !== 'text') return [];
  return briefTextPart(part);
}

function briefToolMessageClass(message: BriefMessage): 'prose' | 'process' {
  return message.parts?.some(isSkillLoadPart) ? 'prose' : 'process';
}

function keepsBriefSegment(segment: {kind: string; name?: string}): boolean {
  if (segment.kind === 'tool') return segment.name === 'load_skill';
  return segment.kind === 'text' || segment.kind === 'a2ui';
}
