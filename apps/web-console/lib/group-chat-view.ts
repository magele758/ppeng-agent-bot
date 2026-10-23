import type { RoomModelConfiguration } from './room-models';

/** Model name only when this bot's own model differs from the global default. */
export function roomMemberModelLabel(models: RoomModelConfiguration | null, botId: string): string | null {
  if (!models) return null;
  const member = models.members.find(item => item.botId === botId);
  if (!member?.model || member.source !== 'bot') return null;
  const fallback = models.defaultModel;
  if (fallback && fallback.providerId === member.model.providerId && fallback.modelId === member.model.modelId) return null;
  const name = member.model.modelId.trim();
  return name.length > 0 ? name : null;
}
export function roomHistoryUrl(roomId: string, older: boolean, cursor: number | null): string {
  const suffix = older && cursor ? `&beforeSeq=${cursor}` : '';
  return `/api/bot-rooms/${roomId}/messages?limit=50${suffix}`;
}
export function roomComposerDisabled(
  room: { status: string } | null,
  busy: boolean,
  text: string,
  hasContext = false
): boolean {
  if (busy || !room) return true;
  if (room.status !== 'active') return true;
  return !text.trim() && !hasContext;
}
export type GroupComposerCommand = 'next' | 'previous' | 'dismiss' | 'choose' | 'send' | 'none';
export function groupComposerCommand(key: string, shift: boolean, composing: boolean, mentionOpen: boolean, optionCount: number, hasActiveMention: boolean): GroupComposerCommand {
  if (mentionOpen) {
    if (key === 'ArrowDown' && optionCount > 0) return 'next';
    if (key === 'ArrowUp' && optionCount > 0) return 'previous';
    if (key === 'Escape') return 'dismiss';
  }
  if (key !== 'Enter' || shift || composing) return 'none';
  if (mentionOpen && hasActiveMention) return 'choose';
  return 'send';
}

export function runGroupComposerCommand(command: GroupComposerCommand, actions: { next: () => void; previous: () => void; dismiss: () => void; choose: () => void; send: () => void }) {
  if (command !== 'none') actions[command]();
}

export function groupMessageMood(message: { id: string; sender: { type: string; id: string } }, lastLiveMessageId: string | undefined, workStates: Record<string, number>): 'speaking' | 'idle' {
  if (message.sender.type !== 'bot') return 'idle';
  if (message.id !== lastLiveMessageId) return 'idle';
  return workStates[message.sender.id] > 0 ? 'speaking' : 'idle';
}
