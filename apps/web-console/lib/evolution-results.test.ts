import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionChipVisible, evolutionEntryVisible } from './evolution-surface.ts';
import { filterEvolutionResults } from './evolution-results.ts';

const rows = [
  { type: 'success', name: 'a', sourceTitle: 'Add retry', experimentBranch: 'exp/evolution-retry', detectedTool: 'cursor' },
  { type: 'failure', name: 'b', sourceTitle: 'Faster build', experimentBranch: 'exp/evolution-build', detectedTool: 'claude' },
  { type: 'skip', name: 'c', sourceTitle: '', experimentBranch: '', detectedTool: null }
];

test('Evolution 入口与顶栏芯片默认不渲染 [AC:ops-console#AC-9]', () => {
  assert.equal(evolutionEntryVisible(), false);
  assert.equal(evolutionChipVisible(0), false);
  assert.equal(evolutionChipVisible(3), false);
});

test('filterEvolutionResults filters by status and keyword', () => {
  assert.equal(filterEvolutionResults(rows, { type: null, query: '' }).length, 3);
  assert.deepEqual(filterEvolutionResults(rows, { type: 'failure', query: '' }).map((r) => r.name), ['b']);
  assert.deepEqual(filterEvolutionResults(rows, { type: null, query: 'RETRY' }).map((r) => r.name), ['a']);
  assert.deepEqual(filterEvolutionResults(rows, { type: null, query: 'claude' }).map((r) => r.name), ['b']);
  assert.deepEqual(filterEvolutionResults(rows, { type: null, query: 'exp/evolution-b' }).map((r) => r.name), ['b']);
  assert.equal(filterEvolutionResults(rows, { type: 'success', query: 'build' }).length, 0);
});
