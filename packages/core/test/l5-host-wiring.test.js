import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKernelHookRegistry } from '@ppeng/agent-loop';
import { RawAgentRuntime } from '../dist/runtime.js';
import {
  bindMemoryAppendixPrompt,
  createRuntimeStepTx
} from '../dist/runtime/l5-bindings.js';
import { createMemorySurfaceStore } from '../dist/session/index.js';
import {
  getSessionEventLog,
  persistEventLog
} from '../dist/session/event-log-saga.js';

function runtimeWithAdapter(handler) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'l5-hooks-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'l5-hooks-state-'));
  const runtime = new RawAgentRuntime({
    repoRoot,
    stateDir,
    modelAdapter: {
      name: 'scripted',
      async runTurn(input) {
        return handler(input);
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  return { runtime, repoRoot, stateDir };
}

test('bindMemoryAppendixPrompt injects stateDir when caller only passes query', async () => {
  const seen = [];
  const prompt = bindMemoryAppendixPrompt({
    stateDir: '/var/state',
    promptBuilder: {
      lastCognitivePhaseBySession: new Map(),
      getRouting() {
        return undefined;
      },
      buildStablePrefix() {
        return '';
      },
      async buildSystemPrompt() {
        return '';
      },
      buildMemoryAppendix() {
        return '';
      },
      async buildMemoryAppendixAsync(_ctx, opts) {
        seen.push(opts);
        return '[mem]';
      }
    }
  });
  assert.equal(await prompt.buildMemoryAppendix({}, { query: 'deploy' }), '[mem]');
  assert.deepEqual(seen[0], { query: 'deploy', stateDir: '/var/state' });
});

test('createRuntimeStepTx rollbackUncommitted retracts EventLog', () => {
  const store = createMemorySurfaceStore();
  const session = store.createSession({ title: 'saga', mode: 'chat', agentId: 'general' });
  const tx = createRuntimeStepTx({ store });
  tx.beginRun({ sessionId: session.id, runId: 'run-a' });
  tx.commitStep({ turn: 0, step: 0, kind: 'model_done', sessionId: session.id });
  const log = getSessionEventLog(store, session.id);
  log.append('assistant/message', { text: 'poison' }, { surfaceOp: 'append' });
  persistEventLog(store, session.id, log);

  tx.rollbackUncommitted('model_error');
  const hydrated = getSessionEventLog(store, session.id).hydrate();
  assert.ok(!hydrated.some((e) => e.data && e.data.text === 'poison'));
});

test('createRuntimeStepTx rollbackUncommitted fail-softs missing tables', () => {
  const tx = createRuntimeStepTx({
    store: {
      getSession() {
        throw new Error('no such table: event_log');
      },
      updateSession() {
        throw new Error('no such table: event_log');
      }
    }
  });
  tx.beginRun({ sessionId: 's1', runId: 'r1' });
  assert.doesNotThrow(() => tx.rollbackUncommitted('model_error'));
});

test('runSession auto-subscribes Runtime hooks and merges options.hooks', async () => {
  const { runtime, repoRoot, stateDir } = runtimeWithAdapter(() => ({
    stopReason: 'end',
    assistantParts: [{ type: 'text', text: 'ok' }]
  }));
  try {
    const runtimeSeen = [];
    runtime.registerKernelHooks((ev) => {
      runtimeSeen.push(ev.type);
    });
    const extra = createKernelHookRegistry();
    const extraSeen = [];
    extra.register((ev) => {
      extraSeen.push(ev.type);
    });
    const onSeen = [];
    const session = runtime.createChatSession({ title: 'hooks', message: 'hi' });
    await runtime.runSession(session.id, {
      hooks: extra,
      onEvent: (ev) => {
        onSeen.push(ev.type);
      }
    });
    assert.ok(runtimeSeen.includes('turn_prepared'));
    assert.ok(runtimeSeen.includes('ended'));
    assert.ok(extraSeen.includes('turn_prepared'));
    assert.ok(extraSeen.includes('ended'));
    assert.ok(onSeen.includes('ended'));
  } finally {
    await runtime.destroy?.();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('ppeng kernel fans Runtime hooks through latch wrap', async () => {
  const { runtime, repoRoot, stateDir } = runtimeWithAdapter(() => ({
    stopReason: 'end',
    assistantParts: [{ type: 'text', text: 'ok-ppeng' }]
  }));
  try {
    runtime.store.setDaemonControl('loop_settings', { kernelVariant: 'ppeng' });
    const seen = [];
    runtime.registerKernelHooks((ev) => {
      seen.push(ev.type);
    });
    const session = runtime.createChatSession({ title: 'ppeng-hooks', message: 'hi' });
    await runtime.runSession(session.id);
    assert.ok(seen.includes('turn_prepared'));
    assert.ok(seen.includes('ended'));
  } finally {
    await runtime.destroy?.();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('canonical bot sends one complete source ledger [AC:question-context#AC-2]', async t => {
  const calls = [];
  const { runtime } = runtimeWithAdapter(input => {
    calls.push(input);
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: '收到。' }] };
  });
  t.after(() => runtime.destroy());
  const bot = runtime.createBot({ name: 'Ledger test' });
  const sid = bot.canonicalSessionId;
  const { SourceLedger } = await import('../dist/learning/sources.js');
  new SourceLedger(runtime.store).record(sid, { kind: 'event', ref: 'audit-note', label: 'external note' });
  runtime.store.appendMessage(sid, 'user', [{ type: 'text', text: '解释启动延迟' }]);
  await runtime.runSession(sid);
  assert.ok(calls.length);
  const parts = calls[0].messages.findLast(message => message.role === 'user').parts;
  const ledgers = parts.filter(part => part.text?.startsWith('[source-ledger]'));
  assert.equal(ledgers.length, 1);
  assert.match(ledgers[0].text, /audit-note/);
});
