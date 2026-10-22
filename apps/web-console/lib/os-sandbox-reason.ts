import type { MessageKey } from '@/lib/i18n';

export const OS_SANDBOX_REASONS = ['saved-os', 'auto-strongest', 'auto-model-os'] as const;
export type OsSandboxReason = (typeof OS_SANDBOX_REASONS)[number];

const MARKER = /\[os-sandbox:(saved-os|auto-strongest|auto-model-os)\]/;

export function parseOsSandboxReason(content: string | undefined): OsSandboxReason | undefined {
  if (!content) return undefined;
  const matched = MARKER.exec(content);
  if (!matched) return undefined;
  switch (matched[1]) {
    case 'saved-os':
    case 'auto-strongest':
    case 'auto-model-os':
      return matched[1];
    default:
      return undefined;
  }
}

export function osSandboxReasonKey(reason: OsSandboxReason): MessageKey {
  switch (reason) {
    case 'saved-os':
      return 'play.turns.osSandbox.savedOs';
    case 'auto-strongest':
      return 'play.turns.osSandbox.autoStrongest';
    case 'auto-model-os':
      return 'play.turns.osSandbox.autoModelOs';
    default: {
      const neverReason: never = reason;
      return neverReason;
    }
  }
}
