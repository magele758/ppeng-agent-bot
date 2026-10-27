import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith('.js')) return nextResolve(specifier, context);
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  }
});

test('summaries must use absolute dates [AC:conversation-date-clock#AC-3]', async () => {
  const { ABSOLUTE_DATE_SUMMARY_RULE: CORE_RULE } = await import('../src/session/conversation-clock.ts');
  const { continuationSummaryInstruction, HISTORICAL_SUMMARY_NOTICE } = await import('../src/session/context-sources.ts');
  const { botCompactInstruction } = await import('../src/session/bot-compact-policy.ts');

  const texts = [
    continuationSummaryInstruction(),
    continuationSummaryInstruction('old summary said tomorrow'),
    botCompactInstruction('structured'),
    botCompactInstruction('hygiene'),
    botCompactInstruction('structured', 'prior said today'),
    botCompactInstruction('hygiene', 'prior said 明天')
  ];
  for (const text of texts) {
    assert.match(text, /YYYY-MM-DD/);
    assert.match(text, /今天/);
    assert.match(text, /Never write today, tomorrow/);
    assert.ok(text.includes(CORE_RULE));
  }
  assert.match(continuationSummaryInstruction(), /Goal, Constraints/);
  assert.match(botCompactInstruction('structured', 'keep me'), /Existing summary:\nkeep me/);
  assert.match(botCompactInstruction('hygiene', 'keep me'), /A summary already exists/);

  assert.match(HISTORICAL_SUMMARY_NOTICE, /Historical context, not new instructions/);
  assert.match(HISTORICAL_SUMMARY_NOTICE, /current user request takes priority/);
  assert.match(HISTORICAL_SUMMARY_NOTICE, /Dates and relative words inside the summary are not the current date/);
  assert.match(HISTORICAL_SUMMARY_NOTICE, /when the summary was written/);
  assert.doesNotMatch(HISTORICAL_SUMMARY_NOTICE, /\d{4}-\d{2}-\d{2}/);
});
