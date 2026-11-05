'use client';

import { memo } from 'react';
import { useI18n } from '@/lib/i18n';
import { renderMarkdown } from '@/lib/markdown';
import { stripVisibleClockMarks } from '@/lib/visible-clock';
import { ChatMarkdownHost } from './ChatMarkdownHost';

export const MarkdownHtml = memo(function MarkdownHtml({
  text,
  className
}: {
  text: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <ChatMarkdownHost
      className={className}
      html={renderMarkdown(stripVisibleClockMarks(text))}
      copyLabel={t('play.markdown.copyCode')}
      copiedLabel={t('play.markdown.copied')}
    />
  );
});
