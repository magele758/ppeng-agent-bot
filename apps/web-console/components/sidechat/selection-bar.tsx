'use client';
import { useState } from 'react';
import type { SidechatThread } from '@ppeng/api-types';
import type { SidechatPanelRequest } from '@/lib/sidechat-editor';
import { threadsForQuote, type QuoteChoice } from '@/lib/sidechat-learning';

type Open = (request: SidechatPanelRequest) => void;
type Labels = {
  start: string;
  explain: string;
  existing: string;
  copy: string;
  copied: string;
  explainPrompt: string;
};

export function SelectionBar({
  choice,
  threads,
  labels,
  open
}: {
  choice: QuoteChoice & { left: number; top: number };
  threads: SidechatThread[];
  labels: Labels;
  open: Open;
}) {
  const [copied, setCopied] = useState(false);
  const matches = threadsForQuote(threads, choice.messageId, choice.anchor.quote);
  return (
    <div className="sidechat-selection" style={{ left: choice.left, top: choice.top }}>
      <BarButton testId="sidechat-selection" label={labels.start} onClick={() => openDraft(choice, open)} />
      <BarButton
        testId="sidechat-explain-selection"
        label={labels.explain}
        onClick={() => openDraft(choice, open, labels.explainPrompt)}
      />
      <ExistingButton matches={matches} label={labels.existing} open={open} />
      <BarButton
        testId="sidechat-copy-selection"
        label={copied ? labels.copied : labels.copy}
        onClick={() => void copyQuote(choice.anchor.quote, setCopied)}
      />
    </div>
  );
}

function BarButton({ testId, label, onClick }: { testId: string; label: string; onClick: () => void }) {
  return (
    <button type="button" data-testid={testId} onPointerDown={(event) => event.preventDefault()} onClick={onClick}>
      {label}
    </button>
  );
}

function ExistingButton({ matches, label, open }: { matches: SidechatThread[]; label: string; open: Open }) {
  if (!matches.length) return null;
  return <BarButton testId="sidechat-open-existing" label={label} onClick={() => openExisting(matches, open)} />;
}

function openDraft(choice: QuoteChoice, open: Open, autoAsk?: string) {
  open({ kind: 'draft', messageId: choice.messageId, anchor: choice.anchor, autoAsk });
}

function openExisting(matches: SidechatThread[], open: Open) {
  const first = matches[0];
  if (!first) return;
  if (matches.length === 1) {
    open({ kind: 'thread', threadId: first.id });
    return;
  }
  open({ kind: 'list', threadIds: matches.map((thread) => thread.id) });
}

async function copyQuote(quote: string, setCopied: (copied: boolean) => void) {
  await navigator.clipboard.writeText(quote);
  setCopied(true);
}
