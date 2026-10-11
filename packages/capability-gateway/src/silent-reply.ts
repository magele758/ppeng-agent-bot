/**
 * Outbound silence contract. A reply is silent only when the whole text is a
 * silence token (whitespace, case, and a single layer of quotes / fences).
 * A sentence that merely mentions the token is delivered as written.
 */

export const SILENT_ACK = {
  zh: '收到，没有更多要补充的。',
  en: 'Got it. Nothing more to add.'
} as const;

const TOKENS = new Set([
  '[SILENT]',
  'SILENT',
  'NO_REPLY',
  'NO REPLY',
  '[NO_REPLY]',
  '[NO REPLY]',
  '[静默]',
  '静默',
  '[沉默]',
  '沉默'
]);

export type ImTurnOrigin = 'human' | 'cron' | 'webhook';
export type SilentAckLocale = keyof typeof SILENT_ACK;

export type ImOutboundDecision =
  | { action: 'send'; text: string }
  | { action: 'drop' };

function unwrapOnce(value: string): string {
  let text = value.trim();
  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (fence?.[1] != null) text = fence[1].trim();
  text = text.replace(/^[`"'“”‘’*_\s]+|[`"'“”‘’*_\s]+$/g, '').trim();
  text = text.replace(/[.!。！…]+$/g, '').trim();
  return text;
}

function unwrapAll(value: string): string {
  let text = value.trim();
  for (let i = 0; i < 4; i += 1) {
    const next = unwrapOnce(text);
    if (next === text) break;
    text = next;
  }
  return text;
}

function canon(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toUpperCase();
}

function isToken(value: string): boolean {
  return TOKENS.has(canon(unwrapAll(value)));
}

export function isSilentMarker(raw: string): boolean {
  const whole = unwrapAll(raw);
  if (!whole) return false;
  if (isToken(whole)) return true;
  const lines = whole.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => isToken(line));
}

export function localeFromUserText(text: string): SilentAckLocale {
  return /[\u3400-\u9fff]/.test(text) ? 'zh' : 'en';
}

export function resolveImOutbound(
  text: string,
  opts: { origin: ImTurnOrigin; locale?: SilentAckLocale; userText?: string }
): ImOutboundDecision {
  if (!isSilentMarker(text)) return { action: 'send', text };
  switch (opts.origin) {
    case 'human': {
      const locale = opts.locale ?? localeFromUserText(opts.userText ?? '');
      return { action: 'send', text: SILENT_ACK[locale] };
    }
    case 'cron':
    case 'webhook':
      return { action: 'drop' };
    default: {
      const neverOrigin: never = opts.origin;
      return neverOrigin;
    }
  }
}
