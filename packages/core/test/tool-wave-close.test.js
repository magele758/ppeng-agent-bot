import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { createMemorySurfaceStore } from '../dist/session/surface-store.js';
import {
  closeOpenToolWave,
  TOOL_WAVE_INTERRUPTED_CONTENT,
  TOOL_WAVE_SKIPPED_STEER_CONTENT
} from '../dist/session/tool-wave-close.js';
import { unmatchedToolCallIds } from '../dist/session/surface-invariants.js';
import {
  drainSteerAtToolLaunch,
  resolveSteerDrainPolicy,
  resolveSteerInboxTarget,
  AGENT_LOOP_SETTINGS_KEY
} from '../dist/session/steer-drain.js';

class ScriptedAdapter {
  constructor(handler) {
    this.name = 'scripted';
    this.handler = handler;
    this.calls = [];
  }
  async runTurn(input) {
    this.calls.push(input);
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

test('closeOpenToolWave synthesizes results so unmatchedToolCallIds is empty', () => {
  const store = createMemorySurfaceStore();
  const session = store.createSession({ title: 'wave', mode: 'chat', agentId: 'general' });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'do' }]);
  store.appendMessage(session.id, 'assistant', [
    { type: 'tool_call', toolCallId: 't1', name: 'read_file', input: { path: 'a' } },
    { type: 'tool_call', toolCallId: 't2', name: 'read_file', input: { path: 'b' } }
  ]);
  assert.deepEqual(unmatchedToolCallIds(store.foldMessages(session.id)), ['t1', 't2']);
  const closed = closeOpenToolWave(store, session.id, 'interrupted');
  assert.deepEqual(closed.closedIds.sort(), ['t1', 't2']);
  assert.deepEqual(unmatchedToolCallIds(store.foldMessages(session.id)), []);
  const results = store
    .foldMessages(session.id)
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'tool_result');
  assert.equal(results.length, 2);
  assert.ok(results.every((p) => p.content.includes('interrupted')));
  void TOOL_WAVE_INTERRUPTED_CONTENT;
});

test('abort() closes an open tool wave on the runtime store', async () => {
  const adapter = new ScriptedAdapter(() => ({
    stopReason: 'tool_use',
    assistantParts: [
      { type: 'tool_call', toolCallId: 'abort1', name: 'read_file', input: { path: 'package.json' } }
    ]
  }));
  const runtime = runtimeWithAdapter(adapter);
  const session = runtime.createChatSession({ title: 'abort-wave', message: 'read' });
  const loop = runtime.createAgentLoop(session.id);
  assert.equal((await loop.step()).type, 'turn_prepared');
  const model = await loop.step();
  assert.equal(model.type, 'model_done');
  assert.ok(unmatchedToolCallIds(runtime.store.foldMessages(session.id)).includes('abort1'));
  await loop.abort();
  assert.deepEqual(unmatchedToolCallIds(runtime.store.foldMessages(session.id)), []);
});

test('resolveSteerDrainPolicy: option > session metadata > loop_settings KV > default', () => {
  assert.equal(resolveSteerDrainPolicy({}), 'next_shot_only');
  assert.equal(
    resolveSteerDrainPolicy({ sessionMetadata: { steerDrainPolicy: 'tool_launch' } }),
    'tool_launch'
  );
  const kv = {
    getDaemonControl(key) {
      assert.equal(key, AGENT_LOOP_SETTINGS_KEY);
      return { steerDrainPolicy: 'tool_launch' };
    }
  };
  assert.equal(resolveSteerDrainPolicy({ store: kv }), 'tool_launch');
  assert.equal(
    resolveSteerDrainPolicy({ option: 'next_shot_only', store: kv }),
    'next_shot_only'
  );
});

test('resolveSteerInboxTarget: tool_launch stays next-step while queue+running waits', () => {
  assert.equal(
    resolveSteerInboxTarget({
      interruptPolicy: 'queue',
      drainPolicy: 'next_shot_only',
      sessionStatus: 'running'
    }),
    'next-run'
  );
  assert.equal(
    resolveSteerInboxTarget({
      interruptPolicy: 'queue',
      drainPolicy: 'tool_launch',
      sessionStatus: 'running'
    }),
    'next-step'
  );
  assert.equal(
    resolveSteerInboxTarget({
      explicitTarget: 'next-run',
      interruptPolicy: 'queue',
      drainPolicy: 'tool_launch',
      sessionStatus: 'running'
    }),
    'next-run'
  );
});

test('drain next_shot_only: inbox stays unclaimed and tools are not skipped', () => {
  const store = createMemorySurfaceStore();
  const session = store.createSession({ title: 'drain-off', mode: 'chat', agentId: 'general' });
  store.appendMessage(session.id, 'assistant', [
    { type: 'tool_call', toolCallId: 'c1', name: 'read_file', input: { path: 'a' } }
  ]);
  store.enqueueSteer(session.id, 'please skip', { target: 'next-step' });
  const drain = drainSteerAtToolLaunch({
    store,
    sessionId: session.id,
    toolCallIds: ['c1'],
    policy: 'next_shot_only'
  });
  assert.equal(drain.drained, false);
  assert.deepEqual(drain.skippedIds, []);
  assert.equal(store.listUnclaimedInbox(session.id).length, 1);
  assert.deepEqual(unmatchedToolCallIds(store.foldMessages(session.id)), ['c1']);
});

test('drain tool_launch: claims input without skipping tools [AC:steer-tool-continuity#AC-2]', () => {
  const store = createMemorySurfaceStore();
  const session = store.createSession({ title: 'drain-on', mode: 'chat', agentId: 'general' });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'go' }]);
  store.appendMessage(session.id, 'assistant', [
    { type: 'tool_call', toolCallId: 'c1', name: 'read_file', input: { path: 'a' } },
    { type: 'tool_call', toolCallId: 'c2', name: 'read_file', input: { path: 'b' } }
  ]);
  store.enqueueSteer(session.id, 'STOP-TOOLS', { target: 'next-step' });
  const drain = drainSteerAtToolLaunch({
    store,
    sessionId: session.id,
    toolCallIds: ['c1', 'c2'],
    policy: 'tool_launch'
  });
  assert.equal(drain.drained, true);
  assert.deepEqual(drain.skippedIds, []);
  assert.equal(store.listUnclaimedInbox(session.id).length, 0);
  const folded = store.foldMessages(session.id);
  assert.deepEqual(unmatchedToolCallIds(folded), ['c1', 'c2']);
  assert.ok(
    folded.some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('STOP-TOOLS')))
  );
  assert.ok(
    !folded.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && String(p.content).includes('skipped_due_to_steer'))
    )
  );
  void TOOL_WAVE_SKIPPED_STEER_CONTENT;
});

test('runtime: both drain settings preserve parallel tools after ordinary steer [AC:steer-tool-continuity#AC-2]', async () => {
  const makeAdapter = () =>
    new ScriptedAdapter((input) => {
      const results = input.messages
        .flatMap((m) => m.parts)
        .filter((p) => p.type === 'tool_result' && p.name === 'read_file');
      if (results.length < 2) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            { type: 'tool_call', toolCallId: 'a', name: 'read_file', input: { path: 'a.txt' } },
            { type: 'tool_call', toolCallId: 'b', name: 'read_file', input: { path: 'b.txt' } }
          ]
        };
      }
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
    });

  const runtimeDefault = runtimeWithAdapter(makeAdapter());
  writeFileSync(join(runtimeDefault.repoRoot, 'a.txt'), 'A');
  writeFileSync(join(runtimeDefault.repoRoot, 'b.txt'), 'B');
  const s1 = runtimeDefault.createChatSession({ title: 'par-default', message: 'read both' });
  await runtimeDefault.runSession(s1.id);
  const defaultResults = runtimeDefault.store
    .foldMessages(s1.id)
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'tool_result' && p.name === 'read_file');
  assert.equal(defaultResults.length, 2);
  assert.ok(defaultResults.some((p) => /A/.test(p.content)));
  assert.ok(defaultResults.some((p) => /B/.test(p.content)));

  const adapterLaunch = makeAdapter();
  const runtimeLaunch = runtimeWithAdapter(adapterLaunch);
  writeFileSync(join(runtimeLaunch.repoRoot, 'a.txt'), 'A');
  writeFileSync(join(runtimeLaunch.repoRoot, 'b.txt'), 'B');
  const s2 = runtimeLaunch.createChatSession({
    title: 'par-launch',
    message: 'read both',
    metadata: { steerDrainPolicy: 'tool_launch', steerInterruptPolicy: 'steer' }
  });
  const loop = runtimeLaunch.createAgentLoop(s2.id, { steerDrainPolicy: 'tool_launch' });
  assert.equal((await loop.step()).type, 'turn_prepared');
  assert.equal((await loop.step()).type, 'model_done');
  await loop.steer('also summarize the files');
  const tools = await loop.step();
  assert.equal(tools.type, 'tools_done');
  assert.ok(tools.results.every((r) => r.ok === true));
  const skipped = runtimeLaunch.store
    .foldMessages(s2.id)
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'tool_result');
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every(p => p.ok));
});
