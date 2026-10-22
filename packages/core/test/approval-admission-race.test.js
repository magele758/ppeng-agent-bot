import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RawAgentRuntime } from '../dist/runtime.js';
import { checkToolApprovals } from '../../agent-loop/dist/runtime/tool-loop.js';

async function admissionRace(variant, { initial = true, fresh = 'pending', rejectEvent = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'approval-admission-'));
  let modelCalls = 0;
  const executed = [];
  const runtime = new RawAgentRuntime({
    repoRoot: dir, stateDir: join(dir, 'state'),
    extraTools: [{
      name: 'admission_probe', description: 'local admission test', inputSchema: { type: 'object' },
      approvalMode: 'always', sideEffectLevel: 'none',
      async execute(_context, input) { executed.push(input.wave); return { ok: true, content: input.wave }; }
    }],
    modelAdapter: { name: 'admission-test', summarizeMessages: async () => '', runTurn: async () => {
      modelCalls++;
      return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'done' }] };
    } }
  });
  try {
    const store = runtime.store;
    store.setDaemonControl('tool_exposure_settings',{mode:'full',pinnedGroups:{}});
    store.setDaemonControl('loop_settings', { kernelVariant: variant });
    const session = runtime.createChatSession({ message: 'continue' });
    function checkpoint(wave, status) {
      const call = { type: 'tool_call', toolCallId: wave, name: 'admission_probe', input: { wave } };
      store.appendMessage(session.id, 'assistant', [call]);
      const current = store.getSession(session.id);
      checkToolApprovals({ env: {}, listApprovals: filter => store.listApprovals(filter), createApproval: input => store.createApproval(input) }, runtime.tools, [call], { session: current }, undefined, current, undefined);
      const approval = store.listApprovals({ status: 'pending' }).find(item => item.sessionId === session.id && item.args.wave === wave);
      assert.ok(approval, 'the real tool gate creates the checkpoint approval');
      if (status === 'approved') store.updateApproval(approval.id, status);
      const interrupt = { kind: 'waiting_approval', toolCallIds: [wave], approvalIds: [approval.id], executedToolCallIds: [], stepCursor: 'tools', writerRunId: wave };
      store.updateSession(session.id, { status: status === 'pending' ? 'waiting_approval' : 'idle', metadata: { interrupt } });
      return { approval, interrupt };
    }
    if (initial) checkpoint('old-wave', 'approved');
    const claim = store.claimWriter.bind(store);
    let injected = false, next;
    store.claimWriter = (id, runId) => {
      if (!injected) {
        injected = true;
        // Release a competing executor's work at the exact read/admission boundary.
        if (initial) store.appendMessage(id, 'tool', [{ type: 'tool_result', toolCallId: 'old-wave', name: 'admission_probe', ok: true, content: 'already done' }]);
        if (fresh === 'consumed') store.updateSession(id, { status: 'idle', metadata: {} });
        else next = checkpoint('new-wave', fresh);
      }
      claim(id, runId);
    };
    const events = [];
    const running = runtime.runSession(session.id, { latch: { emit: async event => {
      if (event.type === 'waiting_approval') {
        events.push(event);
        if (rejectEvent) throw Error('waiting-event-failed');
      }
    } } });
    if (rejectEvent) await assert.rejects(running, /waiting-event-failed/);
    else await running;
    const actual = store.getSession(session.id);
    assert.equal(actual.activeWriterRunId, undefined, 'every exit releases the admitted claim');
    assert.equal(modelCalls, fresh === 'approved' ? 1 : 0);
    assert.deepEqual(executed, fresh === 'approved' ? ['new-wave'] : []);
    if (fresh === 'pending') {
      assert.equal(actual.status, 'waiting_approval');
      assert.deepEqual(actual.metadata.interrupt, next.interrupt);
      assert.equal(store.getApproval(next.approval.id).status, 'pending');
      assert.deepEqual(events.map(event => event.approvalIds), [[next.approval.id]]);
      assert.equal(store.foldMessages(session.id).flatMap(message => message.parts).some(part => part.type === 'tool_result' && part.toolCallId === 'new-wave'), false);
    } else assert.equal(actual.metadata.interrupt, undefined);
  } finally {
    await Promise.allSettled([...runtime.pendingTraceWrites.values()].flatMap(pending => [...pending]));
    await runtime.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SDK admission preserves a newer pending pause [AC:session-multiprocess-state-consistency#AC-4]', () => admissionRace('agent-loop'));
test('core admission preserves a newer pending pause [AC:session-multiprocess-state-consistency#AC-4]', () => admissionRace('ppeng'));
test('SDK admission sees a pause created after the initial read [AC:session-lifecycle-state-consistency#AC-2]', () => admissionRace('agent-loop', { initial: false }));
test('core admission sees a pause created after the initial read [AC:session-lifecycle-state-consistency#AC-2]', () => admissionRace('ppeng', { initial: false }));
test('SDK admission never repeats an already consumed pause [AC:session-multiprocess-state-consistency#AC-4]', () => admissionRace('agent-loop', { fresh: 'consumed' }));
test('core admission never repeats an already consumed pause [AC:session-multiprocess-state-consistency#AC-4]', () => admissionRace('ppeng', { fresh: 'consumed' }));
test('SDK admission releases its claim when the fresh waiting event fails [AC:session-multiprocess-state-consistency#AC-4]', () => admissionRace('agent-loop', { rejectEvent: true }));
test('core admission releases its claim when the fresh waiting event fails [AC:session-multiprocess-state-consistency#AC-4]', () => admissionRace('ppeng', { rejectEvent: true }));
test('SDK admission resumes only the latest approved wave [AC:session-multiprocess-state-consistency#AC-4]', () => admissionRace('agent-loop', { fresh: 'approved' }));
test('core admission resumes only the latest approved wave [AC:session-multiprocess-state-consistency#AC-4]', () => admissionRace('ppeng', { fresh: 'approved' }));
