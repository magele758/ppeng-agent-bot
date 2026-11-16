'use client';
import { createContext, useContext } from 'react';
import type { SidechatPanelRequest } from '../../lib/sidechat-editor';
import type { SidechatThread } from '@ppeng/api-types';
import { useI18n } from '@/lib/i18n';

type SourceActions = {
  threads: SidechatThread[];
  activeId: string | null;
  open: (request: SidechatPanelRequest) => void;
  back: (() => void) | undefined;
};
export const SourceContext = createContext<SourceActions | null>(null);

export function SidechatWholeReply({ messageId, text }: { messageId: string | undefined; text: string }) {
  const actions = useContext(SourceContext);
  const { t } = useI18n();
  if (!actions || !messageId || !text.trim()) return null;
  return (
    <>
      <WholeMarks threads={actions.threads} activeId={actions.activeId} id={messageId} open={actions.open} />
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        data-testid="sidechat-whole"
        onClick={() =>
          actions.open({ kind: 'draft', messageId, anchor: { kind: 'message', quote: text.trim().slice(0, 320) } })
        }
      >
        {t('sidechatSource.whole')}
      </button>
    </>
  );
}
export function SidechatEntry({ tab = false }: { tab?: boolean }) {
  const actions = useContext(SourceContext);
  const { t } = useI18n();
  if (!actions) return null;
  return (
    <button
      type="button"
      role={tab ? 'tab' : undefined}
      className={tab ? 'play-rail__tab' : 'btn btn-ghost btn-sm'}
      data-testid={tab ? 'sidechat-rail-tab' : 'sidechat-entry'}
      onClick={() => actions.open({ kind: 'list' })}
    >
      {t('sidechatSource.entry', { count: actions.threads.length })}
    </button>
  );
}
export function SidechatReturn() {
  const actions = useContext(SourceContext);
  const { t } = useI18n();
  if (!actions?.back) return null;
  return (
    <button type="button" className="btn btn-ghost" data-testid="sidechat-return" onClick={actions.back}>
      {t('sidechatSource.return')}
    </button>
  );
}

function WholeMarks({
  threads,
  activeId,
  id,
  open
}: {
  threads: SidechatThread[];
  id: string;
  activeId: string | null;
  open: SourceActions['open'];
}) {
  const { t } = useI18n();
  const attached = threads.filter((item) => item.messageId === id && item.anchor.kind === 'message');
  if (!attached.length) return null;
  const ids = attached.map((item) => item.id);
  const request: SidechatPanelRequest =
    ids.length === 1 ? { kind: 'thread', threadId: ids[0]! } : { kind: 'list', threadIds: ids };
  const active = activeId !== null && ids.includes(activeId);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      data-sidechat-whole-active={active}
      aria-pressed={active}
      aria-label={t('sidechatSource.mark', { count: ids.length, quote: attached[0]!.anchor.quote.slice(0, 100) })}
      onClick={() => open(request)}
    >
      {t('sidechatSource.wholeCount', { count: ids.length })}
    </button>
  );
}
