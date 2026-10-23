import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemContextNotice } from './system-context-notice.ts';
const summary = 'Goal\n- **Ship a demo**\n\nConstraints\n- Keep private files local\n\nProgress\n- Built\n\nNext steps\n1. Review\n\nHistory source: retained original messages 1-10.';
test('summary preserves sections and source without claiming live goal status [AC:system-context-cards#AC-1]', () => {
  const result = parseSystemContextNotice(summary);
  assert.equal(result?.kind, 'summary');
  if (result?.kind !== 'summary') return;
  assert.deepEqual(result.sections.map(s => s.id), ['goal','constraints','progress','nextSteps']);
  assert.equal(result.sections[0].body, '- **Ship a demo**');
  assert.equal(result.raw, summary);
  assert.equal(parseSystemContextNotice('## Goal\nDo this\n\n## Constraints\nSafely')?.kind, 'summary');
});
test('Jev actions and scores are read conservatively [AC:system-context-cards#AC-2]', () => {
  for (const action of ['need_tools','retry','done']) {
    const result = parseSystemContextNotice(`[jev-route] ${action === 'done' ? 'Achieved: ' : ''}jev-route ${action} noul 0.77${action === 'done' ? '' : '. Continue working.'}`);
    assert.equal(result?.kind, 'jev');
    if (result?.kind !== 'jev') continue;
    assert.equal(result.action, action);
    assert.equal(result.score, '0.77');
  }
  const result = parseSystemContextNotice('[jev-route] jev-route done noul 99');
  assert.equal(result?.kind === 'jev' && result.action, 'unknown');
});
test('partial and unfamiliar content is never discarded or guessed [AC:system-context-cards#AC-3]', () => {
  assert.equal(parseSystemContextNotice('Goal\nA regular message'), null);
  assert.equal(parseSystemContextNotice('I quoted [jev-route] something'), null);
  const raw = '[jev-route] unexpected new format';
  const result = parseSystemContextNotice(raw);
  assert.equal(result?.raw, raw);
  assert.equal(result?.kind === 'jev' && result.action, 'unknown');
  const extra = summary.replace('\n\nHistory source:', '\n\nOther heading\nKeep this too\n\nHistory source:');
  const parsed = parseSystemContextNotice(extra);
  assert.ok(parsed?.kind === 'summary' && parsed.sections.at(-1)?.body.includes('Keep this too'));
});
