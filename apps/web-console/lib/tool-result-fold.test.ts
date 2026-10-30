import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toolResultBodyMode,
  toolResultFoldClass,
  toolResultStatusKind,
  toolResultSummaryFlags
} from './tool-result-fold.ts';

test('toolResultFoldClass covers success and flag classes', () => {
  const base = toolResultFoldClass({
    ok: true,
    stub: false,
    isSubagent: false,
    isSteerSkipped: false,
    spawnBlocked: false
  });
  assert.match(base, /chat-tool-fold--success/);
  assert.doesNotMatch(base, /error|stub|subagent|steer|blocked|model-view/);

  const all = toolResultFoldClass({
    ok: false,
    modelView: true,
    stub: true,
    isSubagent: true,
    isSteerSkipped: true,
    spawnBlocked: true
  });
  assert.match(all, /chat-tool-fold--error/);
  assert.match(all, /model-view/);
  assert.match(all, /stub/);
  assert.match(all, /subagent/);
  assert.match(all, /steer/);
  assert.match(all, /blocked/);
});

test('toolResultStatusKind priority order', () => {
  assert.equal(
    toolResultStatusKind({ isSteerSkipped: true, spawnBlocked: true, isSubagent: true, isTeammate: true, ok: true }),
    'steer'
  );
  assert.equal(
    toolResultStatusKind({ isSteerSkipped: false, spawnBlocked: true, isSubagent: true, isTeammate: true, ok: true }),
    'blocked'
  );
  assert.equal(
    toolResultStatusKind({ isSteerSkipped: false, spawnBlocked: false, isSubagent: true, isTeammate: true, ok: true }),
    'subagent'
  );
  assert.equal(
    toolResultStatusKind({ isSteerSkipped: false, spawnBlocked: false, isSubagent: false, isTeammate: true, ok: true }),
    'teammate'
  );
  assert.equal(
    toolResultStatusKind({ isSteerSkipped: false, spawnBlocked: false, isSubagent: false, isTeammate: false, ok: true }),
    'ok'
  );
  assert.equal(
    toolResultStatusKind({ isSteerSkipped: false, spawnBlocked: false, isSubagent: false, isTeammate: false, ok: false }),
    'err'
  );
});

test('toolResultBodyMode chooses markdown only for live subagent', () => {
  assert.equal(toolResultBodyMode({ isSubagent: true, stub: false, modelView: false, spawnBlocked: false }), 'markdown');
  assert.equal(toolResultBodyMode({ isSubagent: true, stub: true, modelView: false, spawnBlocked: false }), 'io');
  assert.equal(toolResultBodyMode({ isSubagent: true, stub: false, modelView: true, spawnBlocked: false }), 'io');
  assert.equal(toolResultBodyMode({ isSubagent: true, stub: false, modelView: false, spawnBlocked: true }), 'io');
  assert.equal(toolResultBodyMode({ isSubagent: false, stub: false, modelView: false, spawnBlocked: false }), 'io');
});

test('toolResultSummaryFlags lists active pills', () => {
  assert.deepEqual(
    toolResultSummaryFlags({
      confidence: null,
      isLowConf: false,
      modelView: false,
      spawnBlocked: false,
      sandboxReason: null,
      stub: false,
      trimmed: false
    }),
    []
  );
  assert.deepEqual(
    toolResultSummaryFlags({
      confidence: '80%',
      isLowConf: true,
      modelView: true,
      spawnBlocked: true,
      sandboxReason: 'saved-os',
      stub: true,
      trimmed: true
    }),
    ['confidence-low', 'model-view', 'spawn-blocked', 'sandbox', 'stub', 'trimmed']
  );
  assert.deepEqual(
    toolResultSummaryFlags({
      confidence: '90%',
      isLowConf: false,
      modelView: false,
      spawnBlocked: false,
      sandboxReason: null,
      stub: false,
      trimmed: false
    }),
    ['confidence-ok']
  );
});
