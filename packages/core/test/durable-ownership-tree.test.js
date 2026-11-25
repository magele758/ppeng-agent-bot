import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RawAgentRuntime,
  recoverDurableRunsOnBoot,
  writeDurableSettings,
} from '../dist/index.js';

function createSubagentMockAdapter() {
  let parentTurn = 0;
  return {
    name: 'mock-subagent-tree',
    async runTurn(input) {
      const text = input.messages
        .flatMap((m) => m.parts ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');

      // Child subagent session reply
      if (text.includes('SUBAGENT_WORK_MARKER')) {
        return {
          stopReason: 'end',
          assistantParts: [{ type: 'text', text: 'child done cleanly' }],
        };
      }

      // Parent session turn 0: spawn_subagent; turn 1: finalize
      parentTurn += 1;
      if (parentTurn === 1) {
        return {
          stopReason: 'tool_use',
          assistantParts: [
            {
              type: 'tool_call',
              toolCallId: 'tc_spawn_1',
              name: 'spawn_subagent',
              input: {
                role: 'researcher',
                prompt: 'SUBAGENT_WORK_MARKER inspect item',
              },
            },
          ],
        };
      }
      return {
        stopReason: 'end',
        assistantParts: [{ type: 'text', text: 'parent done' }],
      };
    },
    async summarizeMessages() {
      return 'summary';
    },
  };
}

test('spawn_subagent links child durable run to parentRunId and cancelSession cascades bottom-up [AC:durable-tx-tree-and-ui#AC-1]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-tree-core-'));
  const repoDir = join(dir, 'repo');
  const stateDir = join(dir, 'state');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rt = new RawAgentRuntime({
    repoRoot: repoDir,
    stateDir,
    modelAdapter: createSubagentMockAdapter(),
    autoStartScheduler: false,
  });
  rt.store.setDaemonControl('tool_exposure_settings', { mode: 'full', pinnedGroups: {} });
  writeDurableSettings(rt.store, { mode: 'journal_only', chatRestartPolicy: 'auto_resume' });

  const parent = rt.createChatSession({ title: 'Parent durable tree', message: 'delegate work' });
  await rt.runSession(parent.id);

  const parentRun = rt.store.durableJournal.getLatestRunForSession(parent.id);
  assert.ok(parentRun, 'parent durable run should exist');
  const children = rt.store.durableJournal.listChildRuns(parentRun.runId);
  assert.equal(children.length, 1, 'child durable run must link via parentRunId');
  assert.equal(children[0].parentRunId, parentRun.runId);
  assert.equal(children[0].status, 'completed');

  const childSession = rt.store.getSession(children[0].sessionId);
  assert.equal(childSession?.metadata?.parentDurableRunId, parentRun.runId);
  assert.equal(childSession?.metadata?.durableAbandonOnRestart, true);

  // Now test live cascade cancel via cancelSession on a parent+child active tree
  const p2 = rt.createChatSession({ title: 'Cancel parent' });
  const c2 = rt.store.createSession({
    title: 'Cancel child',
    mode: 'subagent',
    agentId: parent.agentId,
    parentSessionId: p2.id,
    background: false,
    metadata: { parentSessionId: p2.id, parentDurableRunId: 'run_p2' },
  });
  rt.store.updateSession(p2.id, { status: 'running' });
  rt.store.updateSession(c2.id, { status: 'running' });
  rt.store.durableJournal.beginRun({ runId: 'run_p2', sessionId: p2.id });
  rt.store.durableJournal.beginRun({ runId: 'run_c2', sessionId: c2.id, parentRunId: 'run_p2' });

  rt.cancelSession(p2.id);

  assert.equal(rt.store.durableJournal.getRun('run_p2')?.status, 'aborted');
  assert.equal(rt.store.durableJournal.getRun('run_c2')?.status, 'aborted');
  assert.equal(rt.store.durableJournal.getRun('run_c2')?.errorText, 'parent_cancelled');
  assert.equal(rt.store.getSession(p2.id)?.status, 'failed');
  assert.equal(rt.store.getSession(c2.id)?.status, 'failed');

  await rt.destroy();
});

test('boot recovery completes interrupted completing trees and abandons orphaned children [AC:durable-tx-tree-and-ui#AC-1]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-tree-boot-'));
  const repoDir = join(dir, 'repo');
  const stateDir = join(dir, 'state');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rt = new RawAgentRuntime({
    repoRoot: repoDir,
    stateDir,
    modelAdapter: createSubagentMockAdapter(),
    autoStartScheduler: false,
  });
  writeDurableSettings(rt.store, { mode: 'journal_only', chatRestartPolicy: 'legacy_fail' });

  const p = rt.createChatSession({ title: 'Crashed parent' });
  const c = rt.store.createSession({
    title: 'Orphan child',
    mode: 'subagent',
    agentId: p.agentId,
    parentSessionId: p.id,
    background: false,
    metadata: { parentSessionId: p.id, parentDurableRunId: 'run_crash_p' },
  });
  rt.store.durableJournal.beginRun({ runId: 'run_crash_p', sessionId: p.id });
  rt.store.durableJournal.beginRun({ runId: 'run_crash_c', sessionId: c.id, parentRunId: 'run_crash_p' });
  rt.store.durableJournal.updateRun('run_crash_c', { status: 'resumable' });

  // Simulate process restart boot recovery
  recoverDurableRunsOnBoot(rt.store);

  assert.equal(rt.store.durableJournal.getRun('run_crash_p')?.status, 'failed');
  assert.equal(rt.store.durableJournal.getRun('run_crash_c')?.status, 'aborted');
  assert.equal(rt.store.durableJournal.getRun('run_crash_c')?.errorText, 'abandoned_on_restart');

  await rt.destroy();
});
