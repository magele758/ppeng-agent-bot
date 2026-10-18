import type { RoomModelConfiguration } from './room-models';

type Translate = (key: 'common.loading' | 'play.groupModel.unconfigured' | 'play.groupModel.botSource' | 'play.groupModel.globalSource') => string;
export function roomDefaultModelLabel(models: RoomModelConfiguration | null, t: Translate): string {
  if (!models) return t('common.loading');
  if (!models.defaultModel) return t('play.groupModel.unconfigured');
  return `${models.defaultModel.providerName} / ${models.defaultModel.modelId}`;
}
export function roomMemberModelLabel(models: RoomModelConfiguration | null, botId: string, t: Translate): string {
  if (!models) return t('common.loading');
  const member = models.members.find(item => item.botId === botId);
  if (!member?.model) return t('play.groupModel.unconfigured');
  const source = member.source === 'bot' ? 'play.groupModel.botSource' : 'play.groupModel.globalSource';
  return `${t(source)} · ${member.model.providerName} / ${member.model.modelId}`;
}
export function roomHistoryUrl(roomId: string, older: boolean, cursor: number | null): string {
  const suffix = older && cursor ? `&beforeSeq=${cursor}` : '';
  return `/api/bot-rooms/${roomId}/messages?limit=50${suffix}`;
}
export function roomComposerDisabled(room: { status: string } | null, busy: boolean, text: string): boolean {
  if (busy || !room) return true;
  return room.status !== 'active' || !text.trim();
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
