import type { MessageKey } from './i18n/messages/types';

/** Daemon answer (403) when a Bot's model / thinking effort pin change needs its owner or an admin. */
export const BOT_PIN_FORBIDDEN = 'bot_pin_forbidden';

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function isBotPinForbidden(error: unknown): boolean {
  return error instanceof Error && error.message === BOT_PIN_FORBIDDEN;
}

/** Readable text for a refused pin change; any other failure keeps `fallback`. */
export function botPinErrorText(t: Translate, error: unknown, fallback: string): string {
  return isBotPinForbidden(error) ? t('play.botPin.forbidden') : fallback;
}
