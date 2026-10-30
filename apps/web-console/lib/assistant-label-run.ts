import type { FeedSlot } from './feed-window.ts';

function flatten(slots: readonly FeedSlot[]): FeedSlot[] {
  return slots.flatMap((slot) => (slot.kind === 'brief-note' ? flatten(slot.folded ?? []) : [slot]));
}

/** 消息下标集合：这些助手消息属于同一连续发言的后续条目，不再显示角色标题。 */
export function continuedAssistantIndexes(
  slots: readonly FeedSlot[],
  roleOf: (messageIndex: number) => string | undefined
): ReadonlySet<number> {
  const hidden = new Set<number>();
  let inRun = false;
  for (const slot of flatten(slots)) {
    if (slot.kind === 'optimistic') inRun = false;
    if (slot.kind !== 'message' || slot.messageIndex == null) continue;
    const role = roleOf(slot.messageIndex);
    if (role === 'user') inRun = false;
    if (role !== 'assistant') continue;
    if (inRun) hidden.add(slot.messageIndex);
    inRun = true;
  }
  return hidden;
}
