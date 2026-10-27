/**
 * kernel-lock: createAgentLoop step / iterator / steer / fold / abort.
 * Phase 0 freeze — do not change these semantics in layering refactors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentLoop } from '../dist/loop.js';
import { RawAgentRuntime } from '../dist/runtime.js';

class ScriptedAdapter {
  constructor(handler) {
    this.name = 'scripted';
    this.handler = handler;
    this.calls = [];
  }

  async runTurn(input) {
    this.calls.push({
      texts: input.messages.flatMap((m) =>
        m.parts.filter((p) => p.type === 'text').map((p) => p.text)
      )
    });
    return this.handler(input, this.calls.length);
  }

  async summarizeMessages() {
    return 'summary';
  }
}

function runtimeWithAdapter(adapter) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'raw-agent-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'raw-agent-state-'));
  return new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: adapter });
}

test('kernel-lock: async iterator yields turn_prepared then model_done then ended', async () => {
  const adapter = new ScriptedAdapter(() => ({
    stopReason: 'end',
    assistantParts: [{ type: 'text', text: 'hi' }]
  }));
  const runtime = runtimeWithAdapter(adapter);
  const session = runtime.createChatSession({ title: 'iter', message: 'hello' });
  const loop = createAgentLoop(
    {
      getSession: (id) => runtime.getSession(id),
      foldMessages: (id) => runtime.store.foldMessages(id),
      enqueueSteer: (id, text, opts) => {
        runtime.enqueueSteer(id, text, opts);
      },
      abortSession: (id) => runtime.cancelSession(id),
      startRun: (id, latch) => runtime.runSession(id, { latch })
    },
    session.id
  );
  const types = [];
  for await (const ev of loop) {
    types.push(ev.type);
  }
  assert.deepEqual(types, ['turn_prepared', 'model_done', 'ended']);
});

test('kernel-lock: fold() is read-only and does not claim inbox', async () => {
  const adapter = new ScriptedAdapter(() => ({
    stopReason: 'end',
    assistantParts: [{ type: 'text', text: 'ok' }]
  }));
  const runtime = runtimeWithAdapter(adapter);
  const session = runtime.createChatSession({ title: 'fold-ro', message: 'hello' });
  runtime.enqueueSteer(session.id, 'PENDING-STEER', { target: 'next-step', key: 'note' });
  const loop = runtime.createAgentLoop(session.id);
  const before = runtime.store.listUnclaimedInbox(session.id);
  assert.equal(before.length, 1);
  const view = await loop.fold();
  assert.ok(Array.isArray(view));
  assert.ok(view.some((m) => m.parts.some((p) => p.type === 'text' && p.text === 'hello')));
  assert.ok(
    view.some((m) => m.parts.some((p) => p.type === 'text' && String(p.text).includes('PENDING-STEER'))),
    'next-step steer is echoed into the transcript so the running turn can see it'
  );
  const after = runtime.store.listUnclaimedInbox(session.id);
  assert.equal(after.length, 1);
  assert.equal(after[0].text, 'PENDING-STEER');
});

test('kernel-lock: abort() stops an in-flight run (existing cancel semantics)', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = new ScriptedAdapter(async () => {
    await gate;
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'late' }] };
  });
  const runtime = runtimeWithAdapter(adapter);
  const session = runtime.createChatSession({ title: 'abort', message: 'go' });
  const loop = runtime.createAgentLoop(session.id);
  const running = loop.run();
  await loop.abort();
  release();
  const ended = await running;
  assert.equal(ended.status, 'failed');
});

test('kernel-lock: abort is not sticky; step emits abort once then a new turn can start', async () => {
  const session = { id: 's-abort', status: 'idle', metadata: {} };
  let runs = 0;
  let aborted = 0;
  const host = {
    getSession: () => session,
    foldMessages: () => [],
    enqueueSteer: () => ({ status: 'started', item: { id: 'steer-1' } }),
    abortSession: () => {
      aborted += 1;
    },
    startRun: async (_id, latch) => {
      runs += 1;
      await latch.emit({ type: 'turn_prepared', messages: [], foldSeqs: [] });
      await latch.emit({ type: 'model_done', stopReason: 'end' });
      await latch.emit({ type: 'ended', reason: 'end' });
      return session;
    }
  };
  const loop = createAgentLoop(host, session.id);

  await loop.abort();
  const first = await loop.step();
  assert.equal(first.type, 'abort');
  assert.equal(runs, 0, 'consuming abort must not start a turn');

  const second = await loop.step();
  assert.equal(second.type, 'turn_prepared');
  assert.equal(runs, 1);
  assert.equal(aborted, 1);
  await loop.abort();
});

test('kernel-lock: steer() clears abort flag so the next step starts a turn', async () => {
  const session = { id: 's-steer-clear', status: 'idle', metadata: {} };
  let runs = 0;
  const host = {
    getSession: () => session,
    foldMessages: () => [],
    enqueueSteer: () => ({ status: 'started', item: { id: 'steer-2' } }),
    abortSession: () => {},
    startRun: async (_id, latch) => {
      runs += 1;
      await latch.emit({ type: 'turn_prepared', messages: [], foldSeqs: [] });
      await latch.emit({ type: 'ended', reason: 'end' });
      return session;
    }
  };
  const loop = createAgentLoop(host, session.id);
  await loop.abort();
  const ack = await loop.steer('keep going');
  assert.equal(ack.status, 'started');
  const ev = await loop.step();
  assert.equal(ev.type, 'turn_prepared');
  assert.equal(runs, 1);
  await loop.abort();
});

test('kernel-lock: RawAgentRuntime.createAgentLoop.step matches createAgentLoop host', async () => {
  const adapter = new ScriptedAdapter(() => ({
    stopReason: 'end',
    assistantParts: [{ type: 'text', text: 'ok' }]
  }));
  const runtime = runtimeWithAdapter(adapter);
  const session = runtime.createChatSession({ title: 'step-api', message: 'x' });
  const loop = runtime.createAgentLoop(session.id);
  const first = await loop.step();
  assert.equal(first.type, 'turn_prepared');
  const second = await loop.step();
  assert.equal(second.type, 'model_done');
});
