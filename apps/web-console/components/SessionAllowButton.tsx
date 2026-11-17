'use client';

import { useI18n } from '@/lib/i18n';
import { isolationClass, isolationLabel, isolationModeOf } from '@/lib/session-tool-grant';

/** Same-kind session grant. Hidden for questions, which are not a tool isolation mode. */
export function SessionAllowButton({
  approval,
  disabled,
  onAllow
}: {
  approval: { id: string; toolName: string };
  disabled?: boolean;
  onAllow: (id: string) => void;
}) {
  const { t } = useI18n();
  if (approval.toolName === 'ask_user') return null;
  return (
    <button
      type="button"
      className="btn btn-sm"
      disabled={disabled}
      aria-label={t('tasks.inbox.allowSessionAria', { tool: approval.toolName })}
      title={t('tasks.inbox.allowSessionHint')}
      onClick={() => onAllow(approval.id)}
    >
      {t('tasks.inbox.allowSession')}
    </button>
  );
}

export function IsolationMark({ toolName, args }: { toolName: string; args: unknown }) {
  const { t } = useI18n();
  const mode = isolationModeOf(toolName, args);
  return <span className={isolationClass(mode)}>{isolationLabel(mode, t)}</span>;
}
