import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toolResultBodyMode,
  toolResultFoldClass,
  toolResultStatusKind,
  toolResultStatusPillSpec,
  toolResultSummaryFlags,
  toolResultSummaryPillPaint,
  toolResultSummaryPillSpecs
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

test('toolResultStatusPillSpec maps kind to class and i18n key', () => {
  assert.equal(toolResultStatusPillSpec('blocked'), null);
  assert.deepEqual(toolResultStatusPillSpec('steer'), {
    className: 'chat-tool-fold__pill chat-tool-fold__pill--steer',
    i18nKey: 'play.turns.steerSkip'
  });
  assert.deepEqual(toolResultStatusPillSpec('subagent'), {
    className: 'chat-tool-fold__pill chat-tool-fold__pill--subagent',
    i18nKey: 'play.turns.subagentDeliver'
  });
  assert.deepEqual(toolResultStatusPillSpec('teammate'), {
    className: 'chat-tool-fold__pill chat-tool-fold__pill--team',
    i18nKey: 'play.turns.teammateReply'
  });
  assert.deepEqual(toolResultStatusPillSpec('ok'), {
    className: 'chat-tool-fold__pill chat-tool-fold__pill--ok',
    i18nKey: 'play.output'
  });
  assert.deepEqual(toolResultStatusPillSpec('err'), {
    className: 'chat-tool-fold__pill chat-tool-fold__pill--err',
    i18nKey: 'play.fail'
  });
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

test('toolResultSummaryPillSpecs builds declarative pill rows', () => {
  assert.deepEqual(
    toolResultSummaryPillSpecs({
      confidence: null,
      isLowConf: false,
      modelView: false,
      spawnBlocked: false,
      sandboxReasonKey: null,
      stub: false,
      trimmed: false
    }),
    []
  );
  assert.deepEqual(
    toolResultSummaryPillSpecs({
      confidence: '80%',
      isLowConf: true,
      modelView: true,
      spawnBlocked: true,
      sandboxReasonKey: 'play.turns.osSandbox.savedOs',
      stub: true,
      trimmed: true
    }),
    [
      {
        id: 'confidence',
        className: 'chat-tool-fold__pill chat-tool-fold__pill--err',
        i18nKey: 'play.turns.confidence',
        value: '80%'
      },
      { id: 'model-view', className: 'chat-tool-fold__pill chat-tool-fold__pill--model-view', i18nKey: 'play.modelViewOnly' },
      { id: 'spawn-blocked' },
      {
        id: 'sandbox',
        className: 'chat-tool-fold__pill',
        i18nKey: 'play.turns.osSandbox.savedOs',
        testId: 'os-sandbox-reason'
      },
      { id: 'stub', className: 'chat-tool-fold__pill chat-tool-fold__pill--stub', i18nKey: 'play.stub' },
      { id: 'trimmed', className: 'chat-tool-fold__pill chat-tool-fold__pill--trim', i18nKey: 'play.trimmed' }
    ]
  );
  assert.deepEqual(
    toolResultSummaryPillSpecs({
      confidence: '90%',
      isLowConf: false,
      modelView: false,
      spawnBlocked: false,
      sandboxReasonKey: undefined,
      stub: false,
      trimmed: false
    }),
    [
      {
        id: 'confidence',
        className: 'chat-tool-fold__pill chat-tool-fold__pill--ok',
        i18nKey: 'play.turns.confidence',
        value: '90%'
      }
    ]
  );
});

test('toolResultSummaryPillPaint maps spawn-blocked, confidence, and plain spans', () => {
  assert.deepEqual(toolResultSummaryPillPaint({ id: 'spawn-blocked' }), { paint: 'spawn-blocked' });
  assert.deepEqual(
    toolResultSummaryPillPaint({
      id: 'confidence',
      className: 'chat-tool-fold__pill chat-tool-fold__pill--err',
      i18nKey: 'play.turns.confidence',
      value: '80%'
    }),
    {
      paint: 'span',
      className: 'chat-tool-fold__pill chat-tool-fold__pill--err',
      textKey: 'play.turns.confidence',
      textParams: { value: '80%' },
      testId: undefined
    }
  );
  assert.deepEqual(
    toolResultSummaryPillPaint({
      id: 'sandbox',
      className: 'chat-tool-fold__pill',
      i18nKey: 'play.turns.osSandbox.savedOs',
      testId: 'os-sandbox-reason'
    }),
    {
      paint: 'span',
      className: 'chat-tool-fold__pill',
      textKey: 'play.turns.osSandbox.savedOs',
      textParams: undefined,
      testId: 'os-sandbox-reason'
    }
  );
  assert.deepEqual(
    toolResultSummaryPillPaint({
      id: 'stub',
      className: 'chat-tool-fold__pill chat-tool-fold__pill--stub',
      i18nKey: 'play.stub'
    }),
    {
      paint: 'span',
      className: 'chat-tool-fold__pill chat-tool-fold__pill--stub',
      textKey: 'play.stub',
      textParams: undefined,
      testId: undefined
    }
  );
});
