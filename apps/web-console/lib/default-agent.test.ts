import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickDefaultAgentId, resolveComposerAgentId } from './default-agent.ts';

const orderedById = [
  { id: 'capability-prober' },
  { id: 'evaluator' },
  { id: 'general' },
  { id: 'main' }
];

test('empty composer does not pick the lexicographically first agent', () => {
  assert.equal(resolveComposerAgentId('', orderedById), 'general');
  assert.equal(resolveComposerAgentId('   ', orderedById), 'general');
  assert.equal(pickDefaultAgentId(orderedById), 'general');
});

test('catalog not loaded yet still defaults to general', () => {
  assert.equal(resolveComposerAgentId('', []), 'general');
});

test('main is the fallback when general is absent', () => {
  assert.equal(
    resolveComposerAgentId('', [{ id: 'capability-prober' }, { id: 'main' }]),
    'main'
  );
});

test('an explicit agent id is preserved', () => {
  assert.equal(resolveComposerAgentId('capability-prober', orderedById), 'capability-prober');
});
