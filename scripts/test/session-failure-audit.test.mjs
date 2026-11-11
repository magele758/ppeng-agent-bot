import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTrial } from '../agent-eval/failure-audit.mjs';
const task = { expected: { exact: 'DONE', maxToolCalls: 1, toolPrefix: [{ name: 'lookup_record', input: { key: 'sample:alpha' }, ok: true }] } };
const trial = { status: 'idle', invariantsOk: true, output: 'DONE', toolCalls: [{ name: 'lookup_record', input: { key: 'alpha' }, ok: false }], pass: false, failures: ['tool prefix input', 'tool prefix result'] };
test('wrong first key remains one failed trial despite a correct answer [AC:literal-tool-identifiers#AC-3]', () => {
  const audit = auditTrial(task, trial);
  assert.equal(audit.classification, 'model_execution');
  assert.equal(audit.finalAnswerCorrect, true);
  assert.equal(audit.firstToolMismatch.index, 0);
  assert.deepEqual(audit.firstToolMismatch.actual.input, { key: 'alpha' });
  assert.deepEqual(audit.failures, trial.failures);
  assert.deepEqual(trial.toolCalls[0].input, { key: 'alpha' });
});
test('inconsistent stored grade requires grader review [AC:literal-tool-identifiers#AC-3]', () => {
  assert.equal(auditTrial(task, { ...trial, pass: true, failures: [] }).classification, 'grading_discrepancy');
});
test('unoffered tool is a setup failure, not model failure [AC:literal-tool-identifiers#AC-3]', () => {
  const bad = { ...trial, promptShapes: [{ tools: [] }], failures: [...trial.failures, 'tools not offered'] };
  assert.equal(auditTrial(task, bad).classification, 'infrastructure');
});
test('successful exact lookup passes without oracle changes', () => {
  const good = { ...trial, toolCalls: task.expected.toolPrefix, pass: true, failures: [] };
  assert.equal(auditTrial(task, good).classification, 'pass');
  assert.equal(auditTrial(task, good).firstToolMismatch, null);
});
