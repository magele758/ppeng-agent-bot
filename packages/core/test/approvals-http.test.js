/**
 * GET /api/approvals ?status filter (daemon routes, driven without a socket).
 * Resolved approvals must be excluded from the pending list that feeds the inbox and nav badge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime } from '../dist/runtime.js';
import { miscRoutes, shouldResumeAfterApproval } from '../../../apps/daemon/dist/routes/misc.js';
import { unmatchedToolCallIds } from '../dist/session/surface-invariants.js';

const ANON = { isolate: false, labProxy: false, user: null };

function makeRuntime() {
  return new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'appr-http-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'appr-http-state-')),
    modelAdapter: { name: 'noop', async runTurn() { return { stopReason: 'end', assistantParts: [] }; }, async summarizeMessages() { return ''; } }
  });
}

async function listApprovals(runtime, query = '') {
  const spec = miscRoutes(runtime, { pkgName: 't', pkgVersion: '0' }).find(
    (r) => r.method === 'GET' && r.pattern === '/api/approvals'
  );
  assert.ok(spec);
  let status = 200;
  let payload;
  const response = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      status = this.statusCode;
      payload = text ? JSON.parse(text) : undefined;
    }
  };
  try {
    await spec.handler({
      request: { headers: {} },
      response,
      url: new URL(`http://x/api/approvals${query}`),
      parts: ['api', 'approvals'],
      params: {},
      requireParam: () => '',
      readBody: async () => ({}),
      auth: ANON
    });
  } catch (error) {
    return { error };
  }
  return { status, payload };
}

test('GET /api/approvals?status=pending omits approved/rejected approvals [AC:console-tasks#AC-4]', async () => {
  const runtime = makeRuntime();
  const session = runtime.store.createSession({ title: 's', mode: 'chat', agentId: 'general' });
  const mk = (toolName) => runtime.store.createApproval({ sessionId: session.id, toolName, reason: 'r', args: {} });
  const keep = mk('bash');
  const rejected = mk('ask_user');
  const approved = mk('write_file');
  runtime.store.updateApproval(rejected.id, 'rejected');
  runtime.store.updateApproval(approved.id, 'approved');

  const all = await listApprovals(runtime);
  assert.equal(all.payload.approvals.length, 3);

  const pending = await listApprovals(runtime, '?status=pending');
  assert.deepEqual(pending.payload.approvals.map((a) => a.id), [keep.id]);

  const done = await listApprovals(runtime, '?status=rejected');
  assert.deepEqual(done.payload.approvals.map((a) => a.id), [rejected.id]);
});

test('GET /api/approvals rejects an unknown status filter', async () => {
  const runtime = makeRuntime();
  const res = await listApprovals(runtime, '?status=bogus');
  assert.match(String(res.error?.message), /Invalid status/);
});

test('shouldResumeAfterApproval resumes a settled rejection and keeps an open wave parked', () => {
  assert.equal(shouldResumeAfterApproval('approved', 'idle', true), true);
  assert.equal(shouldResumeAfterApproval('rejected', 'idle', true), false);
  assert.equal(shouldResumeAfterApproval('rejected', 'idle', false), true);
  assert.equal(shouldResumeAfterApproval('rejected', 'waiting_approval', false), false);
  assert.equal(shouldResumeAfterApproval('approved', 'running', false), false);
});

async function decideApproval(runtime, id, decision) {
  const spec = miscRoutes(runtime, { pkgName: 't', pkgVersion: '0' }).find(
    (route) => route.method === 'POST' && route.pattern === '/api/approvals/:id/:decision'
  );
  assert.ok(spec);
  let payload;
  const response = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      payload = text ? JSON.parse(text) : undefined;
    }
  };
  await spec.handler({
    request: { headers: {} },
    response,
    url: new URL(`http://x/api/approvals/${id}/${decision}`),
    parts: ['api', 'approvals', id, decision],
    params: { id, decision },
    requireParam: (name) => (name === 'id' ? id : decision),
    readBody: async () => ({}),
    auth: ANON
  });
  return payload;
}

test('rejecting the last approval in a wave resumes approved siblings', async () => {
  await assertWaveResumesOnFinalReject();
});

test('rejecting the last approval resumes approved siblings on the ppeng kernel', async () => {
  await assertWaveResumesOnFinalReject('ppeng');
});

async function assertWaveResumesOnFinalReject(kernelVariant) {
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'appr-wave-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'appr-wave-state-')),
    modelAdapter: {
      name: 'scripted',
      async runTurn(input) {
        const results = input.messages.flatMap((message) =>
          message.parts.filter((part) => part.type === 'tool_result')
        );
        if (results.length >= 2) {
          return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'wave-finished' }] };
        }
        return {
          stopReason: 'tool_use',
          assistantParts: [
            { type: 'tool_call', toolCallId: 'call_ok', name: 'bash', input: { command: 'echo approved-sibling' } },
            { type: 'tool_call', toolCallId: 'call_no', name: 'bash', input: { command: 'echo rejected-sibling' } }
          ]
        };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  try {
    if (kernelVariant) {
      runtime.store.setDaemonControl('loop_settings', { kernelVariant });
    }
    const session = runtime.createChatSession({
      title: 'wave',
      message: 'run both',
      metadata: { permissionMode: 'ask' }
    });
    const blocked = await runtime.runSession(session.id);
    assert.equal(blocked.status, 'waiting_approval');
    const pending = runtime.listApprovals('pending').filter((item) => item.sessionId === session.id);
    assert.equal(pending.length, 2);
    const approved = pending.find((item) => item.args?.command === 'echo approved-sibling');
    const rejected = pending.find((item) => item.args?.command === 'echo rejected-sibling');
    assert.ok(approved && rejected);

    const afterApprove = await decideApproval(runtime, approved.id, 'approve');
    assert.equal(afterApprove.session.status, 'waiting_approval');
    assert.equal(
      runtime.listApprovals('pending').filter((item) => item.sessionId === session.id).length,
      1
    );

    const afterReject = await decideApproval(runtime, rejected.id, 'reject');
    assert.equal(afterReject.session.status, 'idle');
    const folded = runtime.store.foldMessages(session.id);
    const results = folded.flatMap((message) => message.parts.filter((part) => part.type === 'tool_result'));
    const rejectedResult = results.find((part) => part.toolCallId === 'call_no');
    const approvedResult = results.find((part) => part.toolCallId === 'call_ok');
    assert.equal(results.filter((part) => part.toolCallId === 'call_no').length, 1);
    assert.equal(results.filter((part) => part.toolCallId === 'call_ok').length, 1);
    assert.match(rejectedResult.content, /was rejected/);
    assert.equal(approvedResult.ok, true);
    assert.equal(runtime.getLatestAssistantText(session.id), 'wave-finished');
    assert.deepEqual(unmatchedToolCallIds(folded), []);
  } finally {
    await runtime.destroy?.();
  }
}

test('only explicit HTTP approval grants approval [AC:ci-audit-p1-p2#AC-4]', async () => {
  for (const action of ['approve', 'reject', '', 'typo', 'APPROVE', undefined]) {
    let granted;
    const runtime = {
      listApprovals: () => [],
      approve: async (_id, decision) => { granted = decision; return { sessionId: 's', status: decision }; },
      getSession: () => undefined
    };
    const route = miscRoutes(runtime, { pkgName: 'test', pkgVersion: '0' }).find(r => r.pattern === '/api/approvals/:id/:decision');
    const call = () => route.handler({ requireParam: key => key === 'id' ? 'a' : action, auth: ANON, response: { setHeader() {}, end() {} } });
    if (action === 'approve' || action === 'reject') {
      await call(); assert.equal(granted, action === 'approve' ? 'approved' : 'rejected');
    } else {
      await assert.rejects(call, /Invalid approval decision/); assert.equal(granted, undefined);
    }
  }
});
