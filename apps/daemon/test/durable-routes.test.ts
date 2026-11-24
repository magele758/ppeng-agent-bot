import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RawAgentRuntime } from '@ppeng/agent-core';
import { durableRoutes } from '../dist/routes/durable.js';

function createInvoker(runtime: RawAgentRuntime) {
  const routes = durableRoutes(runtime);
  return async (
    method: string,
    pattern: string,
    params: Record<string, string> = {},
    body?: unknown
  ) => {
    const route = routes.find((r) => r.method === method && r.pattern === pattern);
    assert.ok(route, `route ${method} ${pattern} must exist`);
    let text = '';
    const response = {
      statusCode: 0,
      setHeader() {},
      end(chunk?: string) {
        text = chunk ?? '';
      },
    };
    await route.handler({
      response,
      requireParam: (name: string) => params[name],
      readBody: async () => body,
    } as never);
    return { status: response.statusCode, body: JSON.parse(text) };
  };
}

test('durable daemon routes expose settings, session inspection, signal wake, reconcile, resolve, rollback, and fork [AC:durable-tx-tree-and-ui#AC-2] [AC:durable-tx-tree-and-ui#AC-3]', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'durable-routes-'));
  const repoDir = join(dir, 'repo');
  const stateDir = join(dir, 'state');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const runtime = new RawAgentRuntime({
    repoRoot: repoDir,
    stateDir,
    autoStartScheduler: false,
    modelAdapter: {
      name: 'mock',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
      },
      async summarizeMessages() {
        return 'summary';
      },
    },
  });
  const invoke = createInvoker(runtime);

  // Settings GET & PATCH
  const getSettings = await invoke('GET', '/api/durable/settings');
  assert.equal(getSettings.status, 200);
  assert.equal(getSettings.body.settings.mode, 'atomic_workspace');

  const patchSettings = await invoke('PATCH', '/api/durable/settings', {}, {
    chatRestartPolicy: 'park_resumable',
    restartLimit: 7,
  });
  assert.equal(patchSettings.status, 200);
  assert.equal(patchSettings.body.settings.chatRestartPolicy, 'park_resumable');
  assert.equal(patchSettings.body.settings.restartLimit, 7);

  // Session with run, childRun, parked step, and unknown step
  const session = runtime.createChatSession({ title: 'Durable HTTP route test', message: 'hello' });
  const run = runtime.store.durableJournal.beginRun({ runId: 'run_http_1', sessionId: session.id });
  const child = runtime.store.durableJournal.beginRun({
    runId: 'run_http_child',
    sessionId: session.id,
    parentRunId: run.runId,
  });
  const parked = runtime.store.durableJournal.planStep({
    runId: run.runId,
    sessionId: session.id,
    turn: 0,
    waveIndex: 0,
    kind: 'tool_call',
    toolCallId: 'tc_park',
    toolName: 'wait_ext',
    idempotencyKey: 'k_park',
    effectClass: 'external_compensatable',
    replayPolicy: 'unsafe',
    argsHash: 'h_park',
  });
  runtime.store.durableJournal.parkStep(parked.stepId, {
    kind: 'park',
    signals: [{ name: 'webhook', key: 'evt-1' }],
  });
  runtime.store.durableJournal.updateRun(run.runId, { status: 'waiting_park' });

  const unknownStep = runtime.store.durableJournal.planStep({
    runId: run.runId,
    sessionId: session.id,
    turn: 0,
    waveIndex: 1,
    kind: 'tool_call',
    toolCallId: 'tc_unk',
    toolName: 'unknown_ext',
    idempotencyKey: 'k_unk',
    effectClass: 'external_irreversible',
    replayPolicy: 'unsafe',
    argsHash: 'h_unk',
  });
  runtime.store.durableJournal.markStepUnknown(unknownStep.stepId, 'process_interrupted');

  // GET /api/sessions/:id/durable returns childRuns, steps, signals
  const detail = await invoke('GET', '/api/sessions/:id/durable', { id: session.id });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.latestRun.runId, child.runId);

  // POST /signals delivers signal and wakes waiting_park run
  const sigRes = await invoke(
    'POST',
    '/api/sessions/:id/durable/signals',
    { id: session.id },
    { runId: run.runId, stepId: parked.stepId, signalName: 'webhook', signalKey: 'evt-1', payload: { ok: 1 } }
  );
  assert.equal(sigRes.status, 200);
  assert.equal(sigRes.body.status, 'delivered');
  assert.equal(sigRes.body.woke, true);

  // Reject missing signal fields
  await assert.rejects(
    invoke('POST', '/api/sessions/:id/durable/signals', { id: session.id }, { stepId: parked.stepId }),
    /required/
  );

  // POST /reconcile
  const recRes = await invoke('POST', '/api/sessions/:id/durable/reconcile', { id: session.id }, {});
  assert.equal(recRes.status, 200);

  // POST /steps/:stepId/resolve
  const resolveRes = await invoke(
    'POST',
    '/api/sessions/:id/durable/steps/:stepId/resolve',
    { id: session.id, stepId: unknownStep.stepId },
    { decision: 'not_applied', note: 'verified via dashboard' }
  );
  assert.equal(resolveRes.status, 200);
  assert.equal(resolveRes.body.ok, true);
  await assert.rejects(
    invoke(
      'POST',
      '/api/sessions/:id/durable/steps/:stepId/resolve',
      { id: session.id, stepId: unknownStep.stepId },
      { decision: 'invalid' }
    ),
    /committed or not_applied/
  );

  // POST /rollback
  const rbRes = await invoke(
    'POST',
    '/api/sessions/:id/durable/rollback',
    { id: session.id },
    { reason: 'test_rollback' }
  );
  assert.equal(rbRes.status, 200);

  // POST /fork
  const forkRes = await invoke(
    'POST',
    '/api/sessions/:id/durable/fork',
    { id: session.id },
    { title: 'Forked branch' }
  );
  assert.equal(forkRes.status, 201);
  assert.ok(forkRes.body.session.id);

  await runtime.destroy();
});
