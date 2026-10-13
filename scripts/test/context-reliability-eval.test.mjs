import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildContextSuite, summarizeContextEvidence, compactRecallPassed } from '../agent-eval/context-reliability.mjs';

test('long context fixtures cover each required scenario without revealing answers in final questions [AC:context-reliability#AC-14]', () => {
  const suite = buildContextSuite();
  assert.equal(suite.length, 10);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../agent-eval/quality-cases/context-reliability.json', import.meta.url))), suite);
  assert.deepEqual([...new Set(suite.map(c => c.category))].sort(), ['constraint', 'correction', 'cross-session', 'post-compact', 'task-switch']);
  for (const c of suite) {
    assert.ok(c.contextSeed.history.length >= 60);
    assert.ok(!c.turns.at(-1).includes(c.expected.exact));
    assert.equal(c.contextSeed.mode === 'bot' || c.contextSeed.mode === 'normal', true);
  }
});

test('semantic evidence cannot pass when skipped, simulated, missing, or incomplete [AC:context-reliability#AC-14]', () => {
  const suite = buildContextSuite();
  const records = suite.map(c => ({ caseId: c.id, variant: 'candidate', trial: 0, pass: true, modelCalls: 1, model: { provider: 'openai-compatible' }, contextEvidence: { historySourceVerified: true, seededMessages: 128, compactRounds: [{ replaced: { startSeq: 1, endSeq: 10 } }, { replaced: { startSeq: 11, endSeq: 20 } }] } }));
  assert.equal(summarizeContextEvidence(suite, [], { trials: 1 }).semanticStatus, 'not_run');
  assert.equal(summarizeContextEvidence(suite, records, { trials: 1, simulation: true }).semanticStatus, 'not_validated');
  assert.equal(summarizeContextEvidence(suite, records.slice(1), { trials: 1 }).semanticStatus, 'incomplete');
  assert.equal(summarizeContextEvidence(suite, records.map(r => ({ ...r, skipped: true })), { trials: 1 }).semanticStatus, 'not_validated');
  assert.equal(summarizeContextEvidence(suite, records, { trials: 1 }).semanticStatus, 'passed_samples');
  assert.equal(summarizeContextEvidence(suite, records.map(r => ({ ...r, contextEvidence: undefined })), { trials: 1 }).semanticStatus, 'not_validated');
  assert.equal(summarizeContextEvidence(suite, records.map((r, i) => i ? r : { ...r, pass: false }), { trials: 1 }).semanticStatus, 'failed');
  assert.equal(summarizeContextEvidence(suite, records, { trials: 1, invalidReasons: ['build changed'] }).semanticStatus, 'invalid');
  assert.equal(summarizeContextEvidence(suite, [...records, records[0]], { trials: 1 }).semanticStatus, 'invalid');
});

test('compact A/B successful execution without factual recall is not semantic success [AC:context-reliability#AC-14]', () => {
  assert.equal(compactRecallPassed({ skipped: true, runs: [] }), false);
  assert.equal(compactRecallPassed({ runs: [] }), false);
  assert.equal(compactRecallPassed({ runs: [{ recalled: false }] }), false);
  assert.equal(compactRecallPassed({ runs: [{ recalled: true, error: 'upstream error' }] }), false);
  assert.equal(compactRecallPassed({ runs: [{ recalled: true }] }), true);
});
