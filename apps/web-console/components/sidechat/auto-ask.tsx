'use client';
import { useEffect, useRef } from 'react';
import type { SidechatDraftBook } from '@/lib/sidechat-editor';

export function AutoAsk({
  prompt,
  address,
  book,
  run
}: {
  prompt?: string;
  address: string;
  book: SidechatDraftBook;
  run: () => void;
}) {
  const sent = useRef('');
  useEffect(() => {
    sendOnce(sent, prompt, address, book, run);
  }, [prompt, address, book, run]);
  return null;
}

function sendOnce(
  sent: { current: string },
  prompt: string | undefined,
  address: string,
  book: SidechatDraftBook,
  run: () => void
) {
  if (!prompt) return;
  const key = address + prompt;
  if (sent.current === key) return;
  sent.current = key;
  book.edit(address, prompt);
  run();
}
