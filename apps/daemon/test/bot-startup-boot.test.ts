import assert from 'node:assert/strict';
import test from 'node:test';
import { setLogLevel } from '@ppeng/agent-core';
import { markListenReady, timeBootPhase } from '../src/boot-timeline.ts';

test('boot logs storage, runtime, gateway, and listen durations [AC:bot-startup-trace#AC-3]', async () => {
  setLogLevel('info');
  const previousFormat = process.env.RAW_AGENT_LOG_FORMAT;
  delete process.env.RAW_AGENT_LOG_FORMAT;
  const seen: Array<Record<string, unknown>> = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    if (args[1] === 'bot_startup' && args[2] && typeof args[2] === 'object') {
      seen.push(args[2] as Record<string, unknown>);
    }
  };
  const bootStartedAt = Date.now();
  try {
    await timeBootPhase('storage_context', async () => 'storage');
    await timeBootPhase('runtime_construct', () => ({ constructed: true }));
    await timeBootPhase('gateway_context', async () => undefined);
    markListenReady(bootStartedAt);
  } finally {
    console.log = original;
    if (previousFormat === undefined) delete process.env.RAW_AGENT_LOG_FORMAT;
    else process.env.RAW_AGENT_LOG_FORMAT = previousFormat;
  }
  for (const phase of ['storage_context', 'runtime_construct', 'gateway_context', 'listen_ready']) {
    const row = seen.find((item) => item.phase === phase);
    assert.ok(row, phase);
    assert.equal(row.scope, 'boot');
    assert.equal(typeof row.durationMs, 'number');
    assert.equal(Number.isFinite(row.durationMs), true);
    assert.ok((row.durationMs as number) >= 0);
  }
});
