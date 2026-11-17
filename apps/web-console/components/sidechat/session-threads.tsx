'use client';
import { useState } from 'react';
import type { SidechatThread } from '@ppeng/api-types';
import { useI18n } from '@/lib/i18n';
import type { SidechatPanelRequest } from '@/lib/sidechat-editor';
import { filterThreads, sortThreads, type ThreadLens, type ThreadOrder } from '@/lib/sidechat-learning';

export function SessionThreads({
  threads,
  view,
  onSelect
}: {
  threads: SidechatThread[];
  view: SidechatPanelRequest;
  onSelect: (request: SidechatPanelRequest) => void;
}) {
  const { t } = useI18n();
  const [lens, setLens] = useState<ThreadLens>('all');
  const [order, setOrder] = useState<ThreadOrder>('recent');
  const shown = sortThreads(filterThreads(threads, lens), order, sourceMessageIds());
  return (
    <>
      <div className="sc-lens" role="group" aria-label={t('sidechat.filters')}>
        <LensButton id="all" current={lens} label={t('sidechat.filterAll')} choose={setLens} />
        <LensButton id="thinking" current={lens} label={t('sidechat.filterThinking')} choose={setLens} />
        <LensButton id="mastered" current={lens} label={t('sidechat.filterMastered')} choose={setLens} />
        <LensButton id="noted" current={lens} label={t('sidechat.filterNoted')} choose={setLens} />
        <button type="button" data-testid="sidechat-sort" aria-pressed={order === 'source'} onClick={() => setOrder(nextOrder(order))}>
          {t(order === 'source' ? 'sidechat.sortSource' : 'sidechat.sortRecent')}
        </button>
      </div>
      {shown.map((thread) => (
        <ThreadRow key={thread.id} thread={thread} pressed={isPressed(view, thread.id)} onSelect={onSelect} />
      ))}
      <FilterEmpty shown={shown.length} total={threads.length} />
    </>
  );
}

function LensButton({
  id,
  current,
  label,
  choose
}: {
  id: ThreadLens;
  current: ThreadLens;
  label: string;
  choose: (lens: ThreadLens) => void;
}) {
  return (
    <button type="button" data-testid={'sidechat-filter-' + id} aria-pressed={current === id} onClick={() => choose(id)}>
      {label}
    </button>
  );
}

function ThreadRow({
  thread,
  pressed,
  onSelect
}: {
  thread: SidechatThread;
  pressed: boolean;
  onSelect: (request: SidechatPanelRequest) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <button
      type="button"
      data-testid="sidechat-thread"
      data-grasp={thread.grasp}
      aria-pressed={pressed}
      onClick={() => onSelect({ kind: 'thread', threadId: thread.id })}
    >
      <span className="sc-index">{thread.ordinal}</span>
      <span className="sc-thread-copy">
        <strong>{thread.title}</strong>
        <small>{thread.anchor.quote}</small>
        <GraspLabel grasp={thread.grasp} label={t(graspKey(thread.grasp))} />
        <ThreadNote note={thread.note} />
      </span>
      <time dateTime={thread.updatedAt}>{new Date(thread.updatedAt).toLocaleDateString(locale)}</time>
    </button>
  );
}

function GraspLabel({ grasp, label }: { grasp: SidechatThread['grasp']; label: string }) {
  return <small data-testid={'sidechat-grasp-label-' + grasp}>{label}</small>;
}

function ThreadNote({ note }: { note: string }) {
  if (!note) return null;
  return <em className="sc-thread-note">{note}</em>;
}

function FilterEmpty({ shown, total }: { shown: number; total: number }) {
  const { t } = useI18n();
  if (shown > 0 || total === 0) return null;
  return <p className="sc-note">{t('sidechat.noMatches')}</p>;
}

function isPressed(view: SidechatPanelRequest, id: string) {
  return view.kind === 'thread' && view.threadId === id;
}

function nextOrder(order: ThreadOrder): ThreadOrder {
  return order === 'recent' ? 'source' : 'recent';
}

function graspKey(grasp: SidechatThread['grasp']) {
  return grasp === 'mastered' ? 'sidechat.graspMastered' : 'sidechat.graspThinking';
}

function sourceMessageIds() {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll<HTMLElement>('[data-sidechat-message]')].flatMap(messageId);
}

function messageId(row: HTMLElement) {
  return row.dataset.sidechatMessage ? [row.dataset.sidechatMessage] : [];
}
