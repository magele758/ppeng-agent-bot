'use client';

import { useMemo, type MouseEvent } from 'react';

const EMPTY_COPY_BUTTON = '<button type="button" class="chat-md-code__copy" data-md-copy></button>';
const RESTORE_MS = 1600;
const restoreTimers = new WeakMap<HTMLButtonElement, number>();

type ChatMarkdownHostProps = {
  html: string;
  className?: string;
  copyLabel: string;
  copiedLabel: string;
};

function escapeCopyText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function withCopyLabels(html: string, copyLabel: string): string {
  const labeled = `<button type="button" class="chat-md-code__copy" data-md-copy>${escapeCopyText(copyLabel)}</button>`;
  return html.replaceAll(EMPTY_COPY_BUTTON, labeled);
}

/** Empty string means the write failed, so the button keeps `copyLabel`. */
export function finishCodeCopy(code: string, copiedLabel: string, write: (value: string) => boolean): string {
  if (write(code)) return copiedLabel;
  return '';
}

function copyButtonFrom(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof Element)) return null;
  const node = target.closest('[data-md-copy]');
  if (!(node instanceof HTMLButtonElement)) return null;
  return node;
}

function codeText(button: HTMLButtonElement): string {
  return button.closest('.chat-md-code')?.querySelector('code')?.textContent ?? '';
}

async function writeClipboard(code: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(code);
    return true;
  } catch {
    return false;
  }
}

function scheduleRestore(button: HTMLButtonElement, copyLabel: string): void {
  const pending = restoreTimers.get(button);
  if (pending !== undefined) window.clearTimeout(pending);
  const timer = window.setTimeout(() => {
    button.textContent = copyLabel;
    restoreTimers.delete(button);
  }, RESTORE_MS);
  restoreTimers.set(button, timer);
}

function showCopyResult(button: HTMLButtonElement, label: string, copyLabel: string): void {
  if (!label) return;
  button.textContent = label;
  scheduleRestore(button, copyLabel);
}

function copyFromButton(button: HTMLButtonElement, copyLabel: string, copiedLabel: string): void {
  const code = codeText(button);
  void writeClipboard(code).then((ok) => {
    showCopyResult(button, finishCodeCopy(code, copiedLabel, () => ok), copyLabel);
  });
}

function onHostClick(event: MouseEvent<HTMLDivElement>, copyLabel: string, copiedLabel: string): void {
  const button = copyButtonFrom(event.target);
  if (!button) return;
  copyFromButton(button, copyLabel, copiedLabel);
}

export function ChatMarkdownHost({ html, className, copyLabel, copiedLabel }: ChatMarkdownHostProps) {
  // A fresh `{__html}` object makes React replace the node and drop the selection.
  const markup = useMemo(() => ({ __html: withCopyLabels(html, copyLabel) }), [html, copyLabel]);
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={markup}
      onClick={(event) => onHostClick(event, copyLabel, copiedLabel)}
    />
  );
}
