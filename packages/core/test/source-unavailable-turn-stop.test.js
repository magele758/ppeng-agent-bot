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

function jsonUnavailable(ref) {
  return {
    ok: false,
    content: JSON.stringify({
      error: 'Source unavailable.',
      error_code: 'SOURCE_UNAVAILABLE',
      ref,
      retry: false
    })
  };
}

test('second JSON SOURCE_UNAVAILABLE read of the same source does not execute [AC:memory-read-source-unavailable#AC-1]', async () => {
  let reads = 0;
  const seen = [];
  const tool = {
    name: 'memory_read',
    description: 'memory_read',
    inputSchema: { type: 'object' },
    approvalMode: 'never',
    sideEffectLevel: 'none',
    execute: async (_ctx, args) => {
      reads += 1;
      seen.push(args.ref);
      if (args.ref === 'memory:user:denied') {
        return { ok: false, content: JSON.stringify({ error: 'not authorized', error_code: 'ACCESS_DENIED', ref: args.ref }) };
      }
      if (args.ref === 'memory:scratch:page') {
        return { ok: true, content: JSON.stringify({ ref: args.ref, text: 'page', offset: args.offset ?? 0 }) };
      }
      return jsonUnavailable(args.ref);
    }
  };
  const { traces, aborts, exec } = harness([tool]);
  const signal = new AbortController().signal;
  const ctx = context('sess-json', { signal, writer: 'run-json' });
  const read = exec.memory_read;

  const first = await read(ctx, { ref: 'memory:user:missing' });
  assert.equal(reads, 1);
  assert.equal(JSON.parse(first.content).error_code, 'SOURCE_UNAVAILABLE');
  assert.equal(JSON.parse(first.content).surfaced, undefined);
  assert.equal(aborts.length, 0);
  assert.equal(traces.length, 0);

  const second = await read(ctx, { ref: 'memory:user:missing' });
  assert.equal(reads, 1);
  assert.deepEqual(seen, ['memory:user:missing']);
  const secondBody = JSON.parse(second.content);
  assert.equal(secondBody.error_code, 'SOURCE_UNAVAILABLE');
  assert.equal(secondBody.ref, 'memory:user:missing');
  assert.equal(secondBody.surfaced, true);
  assert.equal(secondBody.retry, false);
  assert.equal(aborts.length, 0);
  assert.equal(traces.length, 0);

  const other = await read(ctx, { ref: 'memory:user:other' });
  assert.equal(reads, 2);
  assert.equal(JSON.parse(other.content).error_code, 'SOURCE_UNAVAILABLE');
  assert.equal(JSON.parse(other.content).surfaced, undefined);
  assert.equal(aborts.length, 0);

  const nextTurn = await read(context('sess-json', { signal: new AbortController().signal, writer: 'run-json' }), { ref: 'memory:user:missing' });
  assert.equal(reads, 3);
  assert.equal(JSON.parse(nextTurn.content).error_code, 'SOURCE_UNAVAILABLE');
  assert.equal(JSON.parse(nextTurn.content).surfaced, undefined);

  const page = await read(ctx, { ref: 'memory:scratch:page', offset: 0 });
  const nextPage = await read(ctx, { ref: 'memory:scratch:page', offset: 7 });
  assert.equal(page.ok, true);
  assert.equal(nextPage.ok, true);
  assert.equal(reads, 5);

  const denied = await read(ctx, { ref: 'memory:user:denied' });
  const deniedAgain = await read(ctx, { ref: 'memory:user:denied' });
  assert.equal(JSON.parse(denied.content).error_code, 'ACCESS_DENIED');
  assert.equal(JSON.parse(deniedAgain.content).error_code, 'ACCESS_DENIED');
  assert.equal(denied.content.includes('SOURCE_UNAVAILABLE'), false);
  assert.equal(deniedAgain.content.includes('SOURCE_UNAVAILABLE'), false);
  assert.equal(reads, 7);
  assert.equal(aborts.length, 0);
});
