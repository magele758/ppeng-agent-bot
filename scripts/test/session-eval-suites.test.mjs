import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSuite, gradeTask } from '../agent-eval/quality.mjs';

const load = name => JSON.parse(readFileSync(new URL(`../agent-eval/quality-cases/${name}`, import.meta.url), 'utf8'));
const normalize = text => text.trim().replace(/\s+/g, ' ');

function acceptsToolPrefix() {
  try {
    validateSuite([{
      id: 'prefix-probe',
      category: 'tool-use',
      turns: ['probe'],
      expected: { exact: 'ok', toolPrefix: [{ name: 'lookup_record', input: { key: 'probe' }, ok: true }] },
    }]);
    return true;
  } catch (error) {
    if (String(error?.message ?? error).includes('unknown grader toolPrefix')) return false;
    throw error;
  }
}

function trialFromScript(task) {
  const toolCalls = [];
  const state = {};
  let output = '';
  for (const step of task.script) {
    if (step.tool) {
      const ok = step.ok !== false;
      toolCalls.push({ name: step.tool, input: step.input, ok });
      if (step.tool === 'save_result' && ok) state[step.input.key] = step.input.value;
    }
    if (typeof step.text === 'string') output = step.text;
  }
  return {
    status: 'idle',
    output,
    state,
    toolCalls,
    invariantsOk: true,
    promptShapes: [{ tools: ['lookup_record', 'save_result'] }],
  };
}

test('regression keeps every original task and does not overlap the harder set [AC:session-eval-lift#AC-5]', () => {
  const starter = load('starter.json');
  const regression = load('regression.json');
  const capability = load('capability.json');
  const starterIds = new Set(starter.map(task => task.id));
  const regressionIds = new Set(regression.map(task => task.id));
  const capabilityIds = new Set(capability.map(task => task.id));
  const categories = new Set(['instruction-following', 'tool-use', 'recovery', 'trust-boundary', 'context']);

  assert.ok(regression.length >= 30);
  assert.ok(capability.length >= 8);
  for (const id of starterIds) assert.ok(regressionIds.has(id), id);
  for (const id of capabilityIds) assert.equal(regressionIds.has(id), false, id);
  assert.equal(regressionIds.size, regression.length);
  assert.equal(capabilityIds.size, capability.length);

  const turns = [...regression, ...capability].flatMap(task => task.turns.map(normalize));
  assert.equal(new Set(turns).size, turns.length);

  const untrusted = regression.find(task => task.id === 'untrusted-record-injection');
  assert.equal(Object.hasOwn(untrusted.expected, 'toolPrefix'), false);
  const injection = capability.find(task => task.id === 'injection-exact-key');
  assert.equal(injection.expected.toolPrefix[0].input.key, 'document:policy');

  for (const task of regression) {
    if (starterIds.has(task.id)) continue;
    assert.match(task.id, /^[a-z0-9_-]+$/);
    assert.ok(categories.has(task.category), task.id);
    assert.ok(task.turns.length > 0 && task.turns.every(turn => typeof turn === 'string' && turn.trim()));
    assert.ok(['exact', 'json', 'state'].some(key => Object.hasOwn(task.expected, key)), task.id);
    assert.ok(Array.isArray(task.script) && task.script.length > 0, task.id);
  }

  if (acceptsToolPrefix()) {
    validateSuite(regression);
    validateSuite(capability);
  }
  for (const task of [...regression, ...capability]) {
    const graded = gradeTask(task, trialFromScript(task));
    assert.equal(graded.pass, true, `${task.id}: ${graded.failures.join('; ')}`);
  }
});
