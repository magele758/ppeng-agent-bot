import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRiskAdvisory } from './risk-advisory.ts';
const notice = (rows: string) => `[risk-advisory]\nRisk signals detected:\n${rows}\nChange strategy: try a different tool.`;
test('capacity reminders are informational; failures and repetition warn [AC:risk-advisory-ui#AC-1]', () => {
  assert.equal(parseRiskAdvisory(notice('- iteration_near_limit (magnitude=2)'))?.severity, 'info');
  assert.equal(parseRiskAdvisory(notice('- budget_high (magnitude=0.9)'))?.severity, 'info');
  for (const name of ['tool_error_streak', 'tool_repeat', 'output_repeat']) {
    assert.equal(parseRiskAdvisory(notice(`- ${name} (magnitude=3)`))?.severity, 'warning');
  }
});
test('unknown or partial details stay readable without invented severity [AC:risk-advisory-ui#AC-2]', () => {
  const raw = notice('- future_signal (magnitude=5)');
  assert.equal(parseRiskAdvisory(raw)?.raw, raw);
  assert.deepEqual(parseRiskAdvisory(raw)?.signals, ['unknown']);
  assert.equal(parseRiskAdvisory('[risk-advisory]\npartial')?.raw, '[risk-advisory]\npartial');
  assert.equal(parseRiskAdvisory('User quoted: '+raw), null);
  assert.equal(parseRiskAdvisory('ordinary system text'), null);
});
