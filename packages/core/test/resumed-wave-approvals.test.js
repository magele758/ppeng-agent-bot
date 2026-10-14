import test from 'node:test';
import assert from 'node:assert/strict';
import { continueResumedToolWave } from '../dist/turn/kernel.js';

test('core resume passes settled approval ids into the tool gate', async () => {
  const seen = [];
  const executed = [];
  const session = {
    id: 's1',
    status: 'running',
    metadata: {},
    agentId: 'a1',
    mode: 'chat',
    title: 't',
    createdAt: '',
    updatedAt: ''
  };
  const agent = { id: 'a1', name: 'A', role: 'assistant', instructions: '', capabilities: [] };
  const call = { type: 'tool_call', toolCallId: 'bash-1', name: 'echo', input: { command: 'ls' } };
  const store = {
    foldMessages: () => [{ parts: [call] }],
    getSession: () => session,
    listApprovals: () => [],
    updateSession: (_id, patch) => ({ ...session, ...patch, metadata: patch.metadata ?? session.metadata }),
    getDaemonControl: () => undefined,
    appendMessage() {}
  };
  const host = {
    store,
    repoRoot: '/',
    stateDir: '/state',
    tools: [
      {
        name: 'echo',
        description: 'echo',
        inputSchema: {},
        approvalMode: 'never',
        sideEffectLevel: 'none',
        async execute() {
          return { ok: true, content: 'ok' };
        }
      }
    ],
    emitTrace() {},
    mergeSessionMetadata: () => session,
    async checkToolApprovals(...args) {
      seen.push(args[6]);
      return 'proceed';
    },
    async executeToolCalls(calls) {
      executed.push(...calls.map((item) => item.toolCallId));
      return calls.map((item) => ({
        toolCallId: item.toolCallId,
        name: item.name,
        ok: true,
        content: 'ok'
      }));
    },
    processToolResults() {}
  };
  const parked = await continueResumedToolWave({
    host,
    agent,
    sessionId: 's1',
    turn: 0,
    remaining: [call],
    context: {
      repoRoot: '/',
      stateDir: '/state',
      session,
      agent,
      abortSignal: new AbortController().signal
    },
    filePolicy: undefined,
    allowExternalAiTools: false,
    interrupt: {
      kind: 'waiting_approval',
      toolCallIds: ['bash-1'],
      approvalIds: ['ap-1'],
      executedToolCallIds: [],
      stepCursor: 'tools'
    },
    writerRunId: 'run-1',
    session,
    emitStep: async () => {}
  });
  assert.equal(parked, undefined);
  assert.deepEqual(seen, [['ap-1']]);
  assert.deepEqual(executed, ['bash-1']);
});
