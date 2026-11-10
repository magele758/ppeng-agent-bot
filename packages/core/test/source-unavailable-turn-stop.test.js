import test from 'node:test';
import assert from 'node:assert/strict';
import { toolsForTurn } from '../dist/runtime/tool-loop.js';

const SOURCE = 'Source unavailable.';
const STOPPED = 'Source unavailable. Stopped this turn. Do not call this tool again.';

function unavailableTool(name) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async () => ({ ok: false, content: SOURCE })
  };
}

function context(sessionId, extra = {}) {
  return {
    repoRoot: '/tmp',
    stateDir: '/tmp',
    session: {
      id: sessionId,
      metadata: {},
      ...(extra.writer === undefined ? {} : { activeWriterRunId: extra.writer })
    },
    agent: { id: 'general', role: 'assistant', instructions: '', capabilities: [] },
    abortSignal: extra.signal
  };
}

function harness(tools) {
  const traces = [];
  const aborts = [];
  const wrapped = toolsForTurn({
    tools: [],
    store: {},
    envApprovalPolicy: undefined,
    maxParallelToolCalls: 1,
    modelAdapter: {},
    stateDir: '/tmp',
    emitTrace(sessionId, event) {
      traces.push({ sessionId, event });
    },
    abortTurn(sessionId, signal) {
      aborts.push({ sessionId, signal });
    }
  }, tools);
  return {
    traces,
    aborts,
    exec: Object.fromEntries(wrapped.map((tool) => [tool.name, tool.execute.bind(tool)]))
  };
}

test('one abort signal remembers each unavailable source once, then stops the turn', async () => {
  const { traces, aborts, exec } = harness([
    unavailableTool('memory_read'),
    unavailableTool('history_search'),
    unavailableTool('history_read')
  ]);
  const signal = new AbortController().signal;
  const ctx = context('sess-sig', { signal, writer: 'run-1' });

  const first = await exec.memory_read(ctx, { ref: 'a' });
  assert.equal(first.ok, false);
  assert.equal(first.content, SOURCE);
  assert.equal(aborts.length, 0);
  assert.equal(traces.length, 0);

  const second = await exec.memory_read(ctx, { ref: 'b' });
  assert.equal(second.ok, false);
  assert.equal(second.content, STOPPED);
  assert.deepEqual(aborts, [{ sessionId: 'sess-sig', signal }]);
  assert.equal(traces[0].sessionId, 'sess-sig');
  assert.equal(traces[0].event.kind, 'recovery_abort');
  assert.deepEqual(traces[0].event.payload, {
    reason: 'source_unavailable',
    tool: 'memory_read',
    trigger: 'source_unavailable'
  });

  const otherTool = await exec.history_search(ctx, {});
  assert.equal(otherTool.content, SOURCE);
  const otherSignal = await exec.history_search(context('sess-sig', { signal: new AbortController().signal }), {});
  assert.equal(otherSignal.content, SOURCE);

  const sameSignalOtherSession = await exec.memory_read(context('other-session', { signal }), {});
  assert.equal(sameSignalOtherSession.content, STOPPED);
  const firstRead = await exec.history_read(context('other-session', { signal }), {});
  assert.equal(firstRead.content, SOURCE);
});

test('writer run id isolates source-unavailable stops, and a large cache is dropped', async () => {
  const { traces, aborts, exec } = harness([unavailableTool('history_read')]);
  const read = exec.history_read;

  assert.equal((await read(context('sess-w', { writer: 'run-a' }), {})).content, SOURCE);
  assert.equal((await read(context('sess-w', { writer: 'run-b' }), {})).content, SOURCE);
  assert.equal((await read(context('sess-w'), {})).content, SOURCE);
  assert.equal(traces.length, 0);

  const again = await read(context('sess-w', { writer: 'run-a' }), {});
  assert.equal(again.content, STOPPED);
  assert.equal(aborts.at(-1).sessionId, 'sess-w');
  assert.equal(aborts.at(-1).signal, undefined);
  assert.equal(traces.at(-1).event.payload.tool, 'history_read');

  assert.equal((await read(context('sess-w'), {})).content, STOPPED);
  assert.equal((await read(context('sess-w', { writer: 'run-b' }), {})).content, STOPPED);

  let sawClear = false;
  for (let i = 0; i < 250; i++) {
    await read(context(`bulk-${i}`), {});
    const probe = await read(context('sess-w', { writer: 'run-a' }), {});
    if (probe.content === SOURCE) {
      sawClear = true;
      break;
    }
  }
  assert.equal(sawClear, true);
  assert.equal((await read(context('sess-w', { writer: 'run-a' }), {})).content, STOPPED);
});
