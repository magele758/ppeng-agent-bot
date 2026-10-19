'use client';

import { memo } from 'react';
import { renderMarkdown } from '@/lib/markdown';

/**
 * Memoized HTML host. React compares `dangerouslySetInnerHTML` with ===, so a new
 * `{__html}` object on every parent render replaces the DOM even when the string
 * is unchanged. That clears text selection and looks like the transcript is refreshing.
 */
export const StaticHtml = memo(function StaticHtml({
  html,
  className
}: {
  html: string;
  className?: string;
}) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});

export const MarkdownHtml = memo(function MarkdownHtml({
  text,
  className
}: {
  text: string;
  className?: string;
}) {
  return <StaticHtml className={className} html={renderMarkdown(text)} />;
});
