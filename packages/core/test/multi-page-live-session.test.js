import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';

test('两个网页订阅同一场正在生成的对话，后打开的能看到后续内容且不重跑 [AC:multi-page-live-session#AC-1]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'multi-page-live-'));
  let entered;
  let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let turns = 0;
  const runtime = new RawAgentRuntime({
    repoRoot: join(dir, 'repo'),
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'multi-page',
      summarizeMessages: async () => '',
      completeText: async () => '{"met":true}',
      async runTurn(_input, stream) {
        turns += 1;
        entered();
        stream?.({ type: 'text_delta', text: 'one' });
        await gate;
        stream?.({ type: 'text_delta', text: ' two' });
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'one two' }] };
      },
      runTurnStream(_input, stream) { return this.runTurn(_input, stream); }
    }
  });
  const first = [];
  const second = [];
  let detachSecond = () => undefined;
  let running;
  try {
    const session = runtime.createChatSession({ message: 'hello' });
    running = runtime.runHumanSession(session.id, { onModelStreamChunk: (chunk) => first.push(chunk) });
    await ready;
    detachSecond = runtime.subscribeModelStream(session.id, (chunk) => second.push(chunk));
    release();
    const done = await running;
    assert.equal(turns, 1);
    assert.equal(done.status === 'running', false);
    assert.deepEqual(textOf(first), ['one', ' two']);
    assert.deepEqual(textOf(second), [' two']);
    detachSecond();
    const again = [];
    detachSecond = runtime.subscribeModelStream(session.id, (chunk) => again.push(chunk));
    assert.deepEqual(again, []);
    assert.equal(runtime.getLatestAssistantText(session.id), 'one two');
  } finally {
    release();
    detachSecond();
    await running?.catch(() => undefined);
    await runtime.destroy();
  }
});

function textOf(chunks) {
  return chunks.filter((chunk) => chunk.type === 'text_delta').map((chunk) => chunk.text);
}

test('一个网页断开后，另一个网页继续收到后续内容且回合不停止 [AC:multi-page-live-session#AC-2]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'multi-page-leave-'));
  let entered;
  let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const runtime = new RawAgentRuntime({
    repoRoot: join(dir, 'repo'),
    stateDir: join(dir, 'state'),
    modelAdapter: {
      name: 'multi-page-leave',
      summarizeMessages: async () => '',
      completeText: async () => '{"met":true}',
      async runTurn(_input, stream) {
        entered();
        stream?.({ type: 'text_delta', text: 'keep' });
        await gate;
        stream?.({ type: 'text_delta', text: ' going' });
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'keep going' }] };
      },
      runTurnStream(_input, stream) { return this.runTurn(_input, stream); }
    }
  });
  const stayed = [];
  let running;
  try {
    const session = runtime.createChatSession({ message: 'stay' });
    const detachLeft = runtime.subscribeModelStream(session.id, () => {
      throw new Error('page closed');
    });
    const detachStay = runtime.subscribeModelStream(session.id, (chunk) => stayed.push(chunk));
    running = runtime.runHumanSession(session.id);
    await ready;
    detachLeft();
    release();
    await running;
    assert.deepEqual(textOf(stayed), ['keep', ' going']);
    assert.equal(runtime.getSession(session.id).status === 'failed', false);
    assert.equal(runtime.getLatestAssistantText(session.id), 'keep going');
    detachStay();
  } finally {
    release();
    await running?.catch(() => undefined);
    await runtime.destroy();
  }
});

test('页面状态变化会通知每个正在看这场对话的网页 [AC:multi-page-live-session#AC-3]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'multi-page-state-'));
  const runtime = new RawAgentRuntime({
    repoRoot: join(dir, 'repo'),
    stateDir: join(dir, 'state'),
    modelAdapter: { name: 'idle', summarizeMessages: async () => '', runTurn: async () => ({ stopReason: 'end', assistantParts: [] }) }
  });
  try {
    const session = runtime.createChatSession({ title: 'before', message: 'state' });
    const pages = [[], []];
    const detach = pages.map((page) => runtime.subscribeSessionView(session.id, (view) => page.push(view)));
    runtime.patchSessionView(session.id, { title: 'after', status: 'running' });
    for (const page of pages) {
      assert.equal(page.length >= 1, true);
      assert.equal(page.at(-1).session.title, 'after');
      assert.equal(page.at(-1).session.status, 'running');
    }
    for (const stop of detach) stop();
    runtime.patchSessionView(session.id, { title: 'silent' });
    assert.equal(pages[0].at(-1).session.title, 'after');
    assert.equal(pages[1].at(-1).session.title, 'after');
  } finally {
    await runtime.destroy();
  }
});

test('background run admits a late follower without restarting or losing saved identity [AC:unattended-stream-observation#AC-1]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'late-background-follower-'));
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0, streamedCalls = 0;
  const answer = 'background start then finish';
  const execute = async (_input, emit) => {
    calls++;
    if (emit) streamedCalls++;
    emit?.({ type: 'text_delta', text: 'background start' });
    entered();
    await gate;
    emit?.({ type: 'text_delta', text: ' then finish' });
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: answer }] };
  };
  const runtime = new RawAgentRuntime({ repoRoot: join(dir, 'repo'), stateDir: join(dir, 'state'),
    modelAdapter: { name: 'late-background', summarizeMessages: async () => '', completeText: async () => '{"met":true}', runTurn: execute, runTurnStream: execute } });
  let running, detach = () => {};
  const received = [];
  try {
    const session = runtime.createChatSession({ message: 'background work' });
    running = runtime.runSession(session.id);
    await ready;
    detach = runtime.subscribeModelStream(session.id, chunk => received.push(chunk));
    release();
    await running;
    assert.equal(calls, 1);
    assert.equal(streamedCalls, 1);
    assert.deepEqual(textOf(received), [' then finish']);
    const saved = received.filter(chunk => chunk.type === 'assistant_saved');
    assert.equal(saved.length, 1);
    const replies = runtime.store.listMessages(session.id).filter(message => message.role === 'assistant');
    assert.equal(replies.length, 1);
    assert.equal(saved[0].messageId, replies[0].id);
    assert.equal(runtime.getLatestAssistantText(session.id), answer);
  } finally {
    release(); detach(); await running?.catch(() => {}); await runtime.destroy();
  }
});

test('unattended model repetition is guarded in both kernels [AC:unattended-stream-observation#AC-2]', async () => {
  for (const kernelVariant of ['agent-loop', 'ppeng']) {
    const dir = mkdtempSync(join(tmpdir(), 'background-repetition-'));
    let streamedCalls = 0, plainCalls = 0;
    const spam = '覆'.repeat(500);
    const runtime = new RawAgentRuntime({ repoRoot: join(dir, 'repo'), stateDir: join(dir, 'state'),
      modelAdapter: { name: 'background-repetition', summarizeMessages: async () => '', completeText: async () => '{"met":true}',
        async runTurn() { plainCalls++; return { stopReason: 'end', assistantParts: [{ type: 'text', text: spam }] }; },
        async runTurnStream(input, emit) {
          streamedCalls++;
          emit({ type: 'text_delta', text: spam });
          if (input.signal?.aborted) throw new Error('stream aborted');
          return { stopReason: 'end', assistantParts: [{ type: 'text', text: spam }] };
        }
      } });
    try {
      runtime.store.setDaemonControl('loop_settings', { kernelVariant });
      const session = runtime.createChatSession({ message: 'background check' });
      await runtime.runSession(session.id);
      assert.equal(plainCalls, 0, kernelVariant);
      assert.equal(streamedCalls, 2, kernelVariant);
      assert.equal((runtime.getLatestAssistantText(session.id) ?? "").includes(spam), false, kernelVariant);
      assert.equal(runtime.getSession(session.id).metadata.outcome.reason, 'repetition', kernelVariant);
    } finally { await runtime.destroy(); }
  }
});

test('explicit stream-off and non-stream adapters keep their fallback [AC:unattended-stream-observation#AC-3]', async () => {
  const previous = process.env.RAW_AGENT_STREAM;
  for (const mode of ['disabled', 'unsupported']) {
    if (mode === 'disabled') process.env.RAW_AGENT_STREAM = '0';
    else delete process.env.RAW_AGENT_STREAM;
    const dir = mkdtempSync(join(tmpdir(), 'background-no-stream-'));
    let plainCalls = 0;
    const adapter = { name: 'background-fallback', summarizeMessages: async () => '',
      async runTurn() { plainCalls++; return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'saved normally' }] }; } };
    if (mode === 'disabled') adapter.runTurnStream = async () => { throw new Error('stream explicitly disabled'); };
    const runtime = new RawAgentRuntime({ repoRoot: join(dir, 'repo'), stateDir: join(dir, 'state'), modelAdapter: adapter });
    try {
      const session = runtime.createChatSession({ message: 'background fallback' });
      await runtime.runSession(session.id);
      assert.equal(plainCalls, 1);
      assert.equal(runtime.getLatestAssistantText(session.id), 'saved normally');
    } finally {
      await runtime.destroy();
      if (previous === undefined) delete process.env.RAW_AGENT_STREAM;
      else process.env.RAW_AGENT_STREAM = previous;
    }
  }
});
