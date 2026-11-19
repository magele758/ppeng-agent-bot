import type { MessageKey } from './i18n/messages/types';

/** Bot pin values. Same levels as the global thinking effort setting. */
export type BotThinkingEffort = 'off' | 'low' | 'medium' | 'high';

export const BOT_EFFORT_LEVELS: readonly BotThinkingEffort[] = ['off', 'low', 'medium', 'high'];

/** Dropdown value for "follow the global setting" (no pin saved). */
export const BOT_EFFORT_FOLLOW_GLOBAL = '';

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function levelOrNull(value: unknown): BotThinkingEffort | null {
  return BOT_EFFORT_LEVELS.includes(value as BotThinkingEffort) ? (value as BotThinkingEffort) : null;
}

/** Bot chats store the pin as `metadata.thinkingEffort`; absent means "follow global". */
export function parseBotThinkingEffort(
  metadata: Record<string, unknown> | undefined
): BotThinkingEffort | null {
  return levelOrNull(metadata?.thinkingEffort);
}

/** Level saved on the global card (`GET /api/thinking-effort/settings`), or null when unknown. */
export function readGlobalThinkingEffort(payload: unknown): BotThinkingEffort | null {
  const body = payload as { effective?: { level?: unknown }; settings?: { level?: unknown } } | null | undefined;
  return levelOrNull(body?.effective?.level) ?? levelOrNull(body?.settings?.level);
}

export function botEffortSelectValue(pinned: BotThinkingEffort | null): string {
  return pinned ?? BOT_EFFORT_FOLLOW_GLOBAL;
}

/** Follow-global (and anything unknown) clears the pin. */
export function botEffortFromSelect(value: string): BotThinkingEffort | null {
  return levelOrNull(value);
}

export function botEffortLevelLabel(t: Translate, level: BotThinkingEffort): string {
  return t(`settingsEntries.thinkingEffort.options.${level}.label` as MessageKey);
}

/** Follow-global option text. Names the current global level once it is known. */
export function botEffortFollowLabel(t: Translate, globalLevel: BotThinkingEffort | null): string {
  return globalLevel
    ? t('play.botEffort.followGlobalWith', { level: botEffortLevelLabel(t, globalLevel) })
    : t('play.botEffort.followGlobal');
}

/** What this Bot's next turn uses: its pin, else the global level. */
export function botEffortEffectiveText(
  t: Translate,
  pinned: BotThinkingEffort | null,
  globalLevel: BotThinkingEffort | null
): string {
  if (pinned) return t('play.botEffort.effectivePinned', { level: botEffortLevelLabel(t, pinned) });
  if (globalLevel) return t('play.botEffort.effectiveGlobal', { level: botEffortLevelLabel(t, globalLevel) });
  return t('play.botEffort.effectiveUnknown');
}
