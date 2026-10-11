import type { MessageKey } from './i18n/messages/types';

/** Same whole-message grammar as the daemon Bot forever-chat commands. */
export function isBotComposerCommand(text: string): boolean {
  const trimmed = text.trim();
  return /^\/new$/i.test(trimmed) || /^\/stop$/i.test(trimmed) || /^\/model(?:\s+(\S(?:.*\S)?))?$/i.test(trimmed);
}

/** Lab composer: only a selected Bot, with no attachments, treats these as commands. */
export function planBotComposerSend(input: {
  botSelected: boolean;
  text: string;
  hasAttachments: boolean;
}): 'command' | 'message' {
  if (!input.botSelected || input.hasAttachments || !input.text.trim()) return 'message';
  return isBotComposerCommand(input.text) ? 'command' : 'message';
}

export function botComposerStatusText(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  command:
    | {
        code?: string;
        ok?: boolean;
        arg?: string;
        modelOverride?: { modelId?: string } | null;
      }
    | null
    | undefined
): { text: string; err: boolean } {
  const code = command?.code;
  switch (code) {
    case 'compacted':
      return { text: t('play.botCommand.compacted'), err: false };
    case 'nothing_to_compact':
      return { text: t('play.botCommand.nothingToCompact'), err: false };
    case 'stopped':
      return { text: t('play.botCommand.stopped'), err: false };
    case 'model_set':
      return {
        text: t('play.botCommand.modelSet', { model: command?.modelOverride?.modelId || command?.arg || '' }),
        err: false
      };
    case 'model_cleared':
      return { text: t('play.botCommand.modelCleared'), err: false };
    case 'model_unknown':
      return { text: t('play.botCommand.modelUnknown', { name: command?.arg || '' }), err: true };
    case 'model_ambiguous':
      return { text: t('play.botCommand.modelAmbiguous', { name: command?.arg || '' }), err: true };
    case 'model_usage':
      return { text: t('play.botCommand.modelUsage'), err: false };
    default:
      return { text: t('play.botCommand.failed'), err: true };
  }
}
