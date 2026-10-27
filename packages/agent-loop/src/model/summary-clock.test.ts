import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ABSOLUTE_DATE_SUMMARY_RULE, summaryMessagePayload, summarizeContinuationInstruction } from './model-adapters.js';

it('summarize payload keeps writtenAt and the absolute-date rule [AC:conversation-date-clock#AC-3]', () => {
  const coreSource = readFileSync(new URL('../../../core/src/session/conversation-clock.ts', import.meta.url), 'utf8');
  expect(coreSource.replaceAll("\\'", "'")).toContain(ABSOLUTE_DATE_SUMMARY_RULE);
  expect(summarizeContinuationInstruction(false)).toContain(ABSOLUTE_DATE_SUMMARY_RULE);
  expect(summarizeContinuationInstruction(true)).toContain('summary');
  expect(summarizeContinuationInstruction(true)).toContain(ABSOLUTE_DATE_SUMMARY_RULE);

  const stamped = summaryMessagePayload({
    role: 'user',
    createdAt: '2026-10-20T01:02:03.000Z',
    parts: [{ type: 'text', text: '明天见' }]
  });
  expect(stamped).toEqual({ role: 'user', text: '明天见', writtenAt: '2026-10-20T01:02:03.000Z' });

  const missing = summaryMessagePayload({
    role: 'assistant',
    parts: [{ type: 'text', text: 'ok' }]
  });
  expect(missing).toEqual({ role: 'assistant', text: 'ok' });
  expect(missing).not.toHaveProperty('writtenAt');

  const blank = summaryMessagePayload({
    role: 'user',
    createdAt: '',
    parts: [{ type: 'text', text: 'hi' }]
  });
  expect(blank).not.toHaveProperty('writtenAt');
});
