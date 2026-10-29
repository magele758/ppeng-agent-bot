import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { createAgentLoop } from '../dist/runtime/agent-loop.js';
import { createMemorySurfaceStore } from '../dist/session/surface-store.js';
import { decideSteerAdmission } from '../dist/session/steer-ack.js';
import { closeOpenToolWave, unmatchedToolCallIds } from '../dist/index.js';
import { runOutcomeFromEnd, parseRunOutcome } from '../dist/session/run-outcome.js';
import {
  createWaitingApprovalInterrupt,
  decideInterruptResume,
  parseRunInterrupt
} from '../dist/session/interrupt.js';

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

test('runOutcomeFromEnd: abort / approval wait / protocol fail / idle end', () => {
  assert.equal(runOutcomeFromEnd({ reason: 'abort', sessionStatus: 'failed' }).kind, 'aborted');
  assert.equal(runOutcomeFromEnd({ reason: 'abort', sessionStatus: 'failed' }).failureStage, 'host');
  assert.equal(
    runOutcomeFromEnd({ reason: 'waiting_approval', sessionStatus: 'waiting_approval' }).kind,
    'waiting_approval'
  );
  const protocol = runOutcomeFromEnd({ reason: 'empty_assistant', sessionStatus: 'failed' });
  assert.equal(protocol.kind, 'failed');
  assert.equal(protocol.failureStage, 'recovery');
  const emptyIdle = runOutcomeFromEnd({ reason: 'empty_assistant', sessionStatus: 'idle' });
  assert.equal(emptyIdle.kind, 'idle');
  assert.equal(emptyIdle.failureStage, 'recovery');
  const idle = runOutcomeFromEnd({ reason: 'end', sessionStatus: 'idle' });
  assert.equal(idle.kind, 'idle');
  const done = runOutcomeFromEnd({ reason: 'end', sessionStatus: 'completed' });
  assert.equal(done.kind, 'completed');
});

test('runSession end writes metadata.outcome and ended event carries it', async () => {
  const adapter = new ScriptedAdapter(() => ({
    stopReason: 'end',
    assistantParts: [{ type: 'text', text: 'done' }]
  }));
  const runtime = runtimeWithAdapter(adapter);
  const session = runtime.createChatSession({ title: 'outcome-end', message: 'go' });
  const loop = runtime.createAgentLoop(session.id);
  let ended;
  for await (const ev of loop) {
    if (ev.type === 'ended') ended = ev;
  }
  assert.ok(ended);
  assert.equal(ended.outcome.kind, 'idle');
  assert.equal(ended.outcome.reason, 'end');
  const stored = parseRunOutcome(runtime.getSession(session.id).metadata.outcome);
  assert.equal(stored.kind, 'idle');
});

test('runSession abort writes aborted outcome with host stage', async () => {
  let resolveTurn;
  const hanging = new Promise((resolve) => {
    resolveTurn = resolve;
  });
  const adapter = new ScriptedAdapter(async () => {
    await hanging;
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'late' }] };
  });
  const runtime = runtimeWithAdapter(adapter);
  const session = runtime.createChatSession({ title: 'outcome-abort', message: 'go' });
  const loop = runtime.createAgentLoop(session.id);
  const first = await loop.step();
  assert.equal(first.type, 'turn_prepared');
  const runP = loop.run().catch((err) => err);
  await loop.abort();
  resolveTurn();
  await runP;
  const stored = parseRunOutcome(runtime.getSession(session.id).metadata.outcome);
  assert.ok(stored);
  assert.equal(stored.kind, 'aborted');
  assert.equal(stored.failureStage, 'host');
});

test('waiting_approval interrupt is serializable and resume-decided', () => {
  const interrupt = createWaitingApprovalInterrupt({
    toolCallIds: ['c1'],
    approvalIds: ['a1'],
    writerRunId: 'run_1'
  });
  const session = {
    id: 's',
    status: 'waiting_approval',
    metadata: { interrupt }
  };
  const waiting = decideInterruptResume({ session, pendingApprovalIds: ['a1'] });
  assert.equal(waiting.action, 'yield_waiting');
  assert.deepEqual(waiting.interrupt.toolCallIds, ['c1']);

  const afterApprove = decideInterruptResume({
    session: { ...session, status: 'idle' },
    pendingApprovalIds: []
  });
  assert.equal(afterApprove.action, 'resume_tools');
  assert.equal(parseRunInterrupt(session.metadata).writerRunId, 'run_1');
});

test('waiting_approval event carries interrupt; approve then runSession resumes tools', async () => {
  const adapter = new ScriptedAdapter((input) => {
    const sawSoftBlock = input.messages.some((m) =>
      m.parts.some(
        (p) =>
          p.type === 'tool_result' &&
          p.toolCallId === 'call_wait_soft' &&
          String(p.content ?? '').includes('requestSmartModeApproval')
      )
    );
    const sawResult = input.messages.some((m) =>
      m.parts.some((p) => p.type === 'tool_result' && p.toolCallId === 'call_wait')
    );
    if (sawResult) {
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'after-tools' }] };
    }
    if (!sawSoftBlock) {
      return {
        stopReason: 'tool_use',
        assistantParts: [
          {
            type: 'tool_call',
            toolCallId: 'call_wait_soft',
            name: 'bash',
            input: { command: 'rm -rf /tmp/example' }
          }
        ]
      };
    }
    return {
      stopReason: 'tool_use',
      assistantParts: [
        {
          type: 'tool_call',
          toolCallId: 'call_wait',
          name: 'bash',
          input: {
            command: 'rm -rf /tmp/example',
            requestSmartModeApproval: true,
            smartModeBlockReason: 'Auto-review blocked high-risk bash'
          }
        }
      ]
    };
  });
  const runtime = runtimeWithAdapter(adapter);
  const session = runtime.createChatSession({ title: 'interrupt', message: 'run bash' });
  const blocked = await runtime.runSession(session.id);
  assert.equal(blocked.status, 'waiting_approval');
  const interrupt = parseRunInterrupt(blocked.metadata);
  assert.ok(interrupt);
  assert.ok(interrupt.toolCallIds.includes('call_wait'));
  assert.ok(interrupt.approvalIds.length >= 1);
  assert.equal(interrupt.stepCursor, 'tools');

  const approvals = runtime.listApprovals();
  assert.equal(approvals[0].toolName, 'bash');
  await runtime.approve(approvals[0].id, 'approved');
  const completed = await runtime.runSession(session.id);
  assert.equal(completed.status, 'idle');
  const folded = runtime.store.foldMessages(session.id);
  const unmatched = unmatchedToolCallIds(folded);
  assert.deepEqual(unmatched, []);
  assert.equal(runtime.getLatestAssistantText(session.id), 'after-tools');
});

test('createMemorySurfaceStore + createAgentLoop step/fold with mock adapter', async () => {
  const store = createMemorySurfaceStore();
  const session = store.createSession({ title: 'mem', mode: 'chat', agentId: 'general' });
  store.appendMessage(session.id, 'user', [{ type: 'text', text: 'hi' }]);
  const adapter = new ScriptedAdapter(() => ({
    stopReason: 'end',
    assistantParts: [{ type: 'text', text: 'yo' }]
  }));

  const host = {
    getSession: (id) => store.getSession(id),
    foldMessages: (id) => store.foldMessages(id),
    enqueueSteer: (id, text, opts) => {
      const s = store.getSession(id);
      const decision = decideSteerAdmission({ session: s, text });
      if (!decision.admit) return { status: 'not_submitted', reason: decision.reason };
      const item = store.enqueueSteer(id, text.trim(), opts);
      return { status: decision.status, item };
    },
    abortSession: (id) => {
      closeOpenToolWave(store, id, 'interrupted');
    },
    startRun: async (id, latch) => {
      const folded = store.foldMessages(id);
      await latch.emit({
        type: 'turn_prepared',
        messages: folded,
        foldSeqs: folded.map((m) => m.seq).filter((n) => typeof n === 'number')
      });
      const result = await adapter.runTurn({ messages: folded });
      store.appendMessage(id, 'assistant', result.assistantParts);
      await latch.emit({
        type: 'model_done',
        stopReason: result.stopReason,
        assistant: { parts: result.assistantParts }
      });
      const next = store.updateSession(id, { status: 'idle' });
      await latch.emit({ type: 'ended', reason: 'end', outcome: { kind: 'idle', reason: 'end' } });
      return next;
    }
  };

  const loop = createAgentLoop(host, session.id);
  const prepared = await loop.step();
  assert.equal(prepared.type, 'turn_prepared');
  const model = await loop.step();
  assert.equal(model.type, 'model_done');
  assert.equal(model.assistant.parts[0].text, 'yo');
  const folded = await loop.fold();
  assert.equal(folded[folded.length - 1].parts[0].text, 'yo');
  const ack = await loop.steer('next');
  assert.equal(ack.status, 'started');
});
