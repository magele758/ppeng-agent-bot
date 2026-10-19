'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useI18n } from '@/lib/i18n';
import {
  contextLabelsFromMessage,
  readDroppedContext,
  type ContextLabel,
  type ContextSource,
  type PendingContextSource
} from '@/lib/composer-context';

export function useComposerFileDrop(onAdd: (sources: ContextSource[], truncated: boolean) => void, scope: string) {
  const scopeRef = useRef(scope);
  const generation = useRef(0);
  if (scopeRef.current !== scope) { scopeRef.current = scope; generation.current++; }
  useEffect(() => () => { generation.current++; }, []);
  const [over, setOver] = useState(false);
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;

  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setOver(true);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOver(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setOver(false);
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const started = generation.current;
    void readDroppedContext(transfer).then(
      (result) => {
        if (started !== generation.current || result.sources.length === 0) return;
        onAddRef.current(result.sources, result.truncated);
      },
      () => {
        /* Keep the draft and do not add an empty chip. */
      }
    );
  };

  return { over, onDragEnter, onDragOver, onDragLeave, onDrop };
}

export function ComposerContextChips({
  items,
  onRemove
}: {
  items: readonly PendingContextSource[];
  onRemove: (id: string) => void;
}) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <ul className="composer-context-chips" aria-label={t('play.composer.contextList')}>
      {items.map((item) => (
        <li
          key={item.id}
          className="composer-context-chip"
          data-testid="composer-context-chip"
          data-kind={item.kind}
          data-name={item.name}
        >
          <span className="composer-context-chip__name">{item.name}</span>
          <button
            type="button"
            className="composer-context-chip__remove"
            data-testid="composer-context-remove"
            aria-label={t('play.composer.removeContext', { name: item.name })}
            title={t('play.composer.removeContext', { name: item.name })}
            onClick={() => onRemove(item.id)}
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">{t('play.composer.removeContext', { name: item.name })}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ComposerMessageContext({
  message,
  labels
}: {
  message?: unknown;
  labels?: readonly ContextLabel[];
}) {
  const { t } = useI18n();
  const items = labels ?? contextLabelsFromMessage(message);
  if (items.length === 0) return null;
  return (
    <ul className="composer-message-context" aria-label={t('play.composer.contextWithMessage')}>
      {items.map((item, index) => (
        <li
          key={`${item.kind}:${item.name}:${index}`}
          data-testid="composer-message-context"
          data-kind={item.kind}
          data-name={item.name}
        >
          {item.name}
        </li>
      ))}
    </ul>
  );
}
