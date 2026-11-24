import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DURABLE_DEFAULTS,
  DURABLE_ENUM_VALUES,
  canRollbackToStep,
  durableErrorMessage,
  durableNumberOptions,
  durableSessionEndpoint,
  durableStepResolveEndpoint,
  isStepNeedsOperatorResolve,
} from './durable.ts';
import { zh } from './i18n/messages/zh/index.ts';
import { en } from './i18n/messages/en/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = dirname(HERE);

function collectKeys(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>)
    .flatMap(([k, v]) => {
      const path = prefix ? `${prefix}.${k}` : k;
      return typeof v === 'string' ? [path] : collectKeys(v, path);
    })
    .sort();
}

test('Durable settings defaults, options, i18n parity, and Behavior category registration [AC:durable-tx-tree-and-ui#AC-2]', () => {
  assert.equal(DURABLE_DEFAULTS.mode, 'atomic_workspace');
  assert.equal(DURABLE_DEFAULTS.chatRestartPolicy, 'auto_resume');
  assert.equal(DURABLE_DEFAULTS.waveRollbackPolicy, 'abort_or_tx_only');

  const customLimitOpts = durableNumberOptions('restartLimit', 7);
  assert.ok(customLimitOpts.some((o) => o.value === '7'));
  assert.deepEqual(
    customLimitOpts.map((o) => Number(o.value)),
    [...customLimitOpts.map((o) => Number(o.value))].sort((a, b) => a - b)
  );

  const zhKeys = collectKeys(zh.settingsEntries.durable);
  const enKeys = collectKeys(en.settingsEntries.durable);
  assert.deepEqual(enKeys, zhKeys);

  // Every enum option has both zh and en labels
  for (const [field, values] of Object.entries(DURABLE_ENUM_VALUES)) {
    for (const value of values) {
      const zhOpt = (zh.settingsEntries.durable.options as Record<string, Record<string, string>>)[field]?.[value];
      const enOpt = (en.settingsEntries.durable.options as Record<string, Record<string, string>>)[field]?.[value];
      assert.ok(zhOpt && zhOpt.length > 0, `missing zh option ${field}.${value}`);
      assert.ok(enOpt && enOpt.length > 0, `missing en option ${field}.${value}`);
    }
  }

  // Verify Behavior settings category mounts DurableSettingsCard
  const behaviorSrc = readFileSync(
    join(WEB_ROOT, 'components/sections/settings/categories/behavior.tsx'),
    'utf8'
  );
  assert.match(behaviorSrc, /DurableSettingsCard/);
  assert.match(behaviorSrc, /settingsEntries\.durable\.title/);

  // Verify DurableSettingsCard targets /api/durable/settings without hardcoded user copy
  const cardSrc = readFileSync(join(WEB_ROOT, 'components/DurableSettingsCard.tsx'), 'utf8');
  assert.match(cardSrc, /\/api\/durable\/settings/);
  assert.match(cardSrc, /useI18n/);
});

test('Durable timeline helpers, ops i18n parity, and TrajectoryPanel wiring [AC:durable-tx-tree-and-ui#AC-3]', () => {
  assert.equal(isStepNeedsOperatorResolve({ phase: 'unknown' }), true);
  assert.equal(isStepNeedsOperatorResolve({ phase: 'compensation_failed' }), true);
  assert.equal(isStepNeedsOperatorResolve({ phase: 'committed' }), false);

  assert.equal(canRollbackToStep({ kind: 'tool_call', phase: 'committed' }), true);
  assert.equal(canRollbackToStep({ kind: 'tool_call', phase: 'failed' }), true);
  assert.equal(canRollbackToStep({ kind: 'tool_call', phase: 'unknown' }), false);
  assert.equal(canRollbackToStep({ kind: 'llm_turn', phase: 'committed' }), false);

  assert.equal(durableSessionEndpoint('s/1', '/rollback'), '/api/sessions/s%2F1/durable/rollback');
  assert.equal(
    durableStepResolveEndpoint('s1', 'step/2'),
    '/api/sessions/s1/durable/steps/step%2F2/resolve'
  );
  assert.equal(durableErrorMessage(new Error('boom')), 'boom');
  assert.equal(durableErrorMessage('raw'), 'raw');

  const zhKeys = collectKeys(zh.ops.durable);
  const enKeys = collectKeys(en.ops.durable);
  assert.deepEqual(enKeys, zhKeys);
  assert.ok(zhKeys.includes('runStatus.needs_reconcile'));
  assert.ok(zhKeys.includes('phase.compensation_failed'));

  const trajSrc = readFileSync(join(WEB_ROOT, 'components/TrajectoryPanel.tsx'), 'utf8');
  assert.match(trajSrc, /DurableTimelinePanel/);

  const panelSrc = readFileSync(join(WEB_ROOT, 'components/DurableTimelinePanel.tsx'), 'utf8');
  assert.match(panelSrc, /\/rollback/);
  assert.match(panelSrc, /\/fork/);
  assert.match(panelSrc, /\/reconcile/);
  assert.match(panelSrc, /durableStepResolveEndpoint/);
});
