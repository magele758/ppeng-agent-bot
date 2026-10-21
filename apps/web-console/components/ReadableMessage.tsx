'use client';

import { useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { MarkdownHtml } from './MarkdownHtml';

export function ReadableMessage({ text, role, messageKey }: { text: string; role: string; messageKey?: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const result = role === 'assistant' && messageKey?.startsWith('routine-result:')
    ? /^\[routine:(.+)\] (\w+)\n([\s\S]*?)\nRun: (.+)$/.exec(text) : null;
  const context = messageKey?.startsWith('routine-context:') && /^\[routine-context [^\n]+\]\n[\s\S]*?\n\[\/routine-context\]/.exec(text);
  if (result) {
    const status: Record<string, MessageKey> = { completed: 'polish.completed', failed: 'polish.failed', cancelled: 'polish.cancelled', running: 'polish.running' };
    return <section className="routine-result-card" data-testid="routine-result-card">
      <header><span>{t('polish.routineResult')}</span><strong>{result[1]}</strong><span>{t(status[result[2]] ?? 'polish.unknown')}</span></header>
      <MarkdownHtml className="chat-bubble__body chat-bubble__md" text={result[3]} />
      <details><summary>{t('polish.details')}</summary><pre>{result[4]}</pre></details>
    </section>;
  }
  if (context) return <><details className="routine-context-card"><summary>{t('polish.routineContext')}</summary><pre>{context[0]}</pre></details><MarkdownHtml className="chat-bubble__body chat-bubble__md" text={text.slice(context[0].length)} /></>;
  if (text.length <= 4000) return <MarkdownHtml className="chat-bubble__body chat-bubble__md" text={text} />;
  return <section className="long-message" data-testid="long-message">
    {expanded ? <pre className="long-message__full">{text}</pre> : <MarkdownHtml className="chat-bubble__body chat-bubble__md" text={text.slice(0, 1600) + '\n…'} />}
    <button type="button" className="btn btn-ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t(expanded ? 'polish.collapse' : 'polish.expand')}</button>
  </section>;
}
