'use client';

import { useState } from 'react';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { stripVisibleClockMarks } from '@/lib/visible-clock';
import { MarkdownHtml } from './MarkdownHtml';

export function ReadableMessage({ text, role, messageKey }: { text: string; role: string; messageKey?: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const body = stripVisibleClockMarks(text);
  const result = role === 'assistant' && messageKey?.startsWith('routine-result:')
    ? /^\[routine:(.+)\] (\w+)\n([\s\S]*?)\nRun: (.+)$/.exec(body) : null;
  const context = messageKey?.startsWith('routine-context:') && /^\[routine-context [^\n]+\]\n[\s\S]*?\n\[\/routine-context\]/.exec(body);
  if (result) {
    const status: Record<string, MessageKey> = { completed: 'polish.completed', failed: 'polish.failed', cancelled: 'polish.cancelled', running: 'polish.running' };
    return <section className="routine-result-card" data-testid="routine-result-card">
      <header><span>{t('polish.routineResult')}</span><strong>{result[1]}</strong><span>{t(status[result[2]] ?? 'polish.unknown')}</span></header>
      <MarkdownHtml className="chat-bubble__body chat-bubble__md" text={result[3]} />
      <details><summary>{t('polish.details')}</summary><pre>{result[4]}</pre></details>
    </section>;
  }
  if (context) return <><details className="routine-context-card"><summary>{t('polish.routineContext')}</summary><pre>{context[0]}</pre></details><MarkdownHtml className="chat-bubble__body chat-bubble__md" text={body.slice(context[0].length)} /></>;
  if (body.length <= 4000) return <MarkdownHtml className="chat-bubble__body chat-bubble__md" text={body} />;
  return <section className="long-message" data-testid="long-message">
    {expanded ? <pre className="long-message__full">{body}</pre> : <MarkdownHtml className="chat-bubble__body chat-bubble__md" text={body.slice(0, 1600) + '\n…'} />}
    <button type="button" className="btn btn-ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t(expanded ? 'polish.collapse' : 'polish.expand')}</button>
  </section>;
}
