import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawAgentRuntime, ResourceOwnerStore } from '@ppeng/agent-core';
import { Router } from '../dist/routing.js';
import { buildRoutePolicy } from '../dist/access/policy.js';
import { approvalExplanationRoutes } from '../dist/routes/approval-explanation.js';

function listen(runtime: RawAgentRuntime): Promise<{ port: number; close: () => Promise<void> }> {
  const router = new Router({
    policy: buildRoutePolicy({ runtime, owners: new ResourceOwnerStore(runtime.store.db) }),
    readBody: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      return raw ? JSON.parse(raw) : {};
    }
  }).addAll(approvalExplanationRoutes(runtime));
  const server = createServer((request, response) => {
    void router.dispatch(request, response, new URL(request.url ?? '/', 'http://localhost')).then((found) => {
      if (!found) {
        response.statusCode = 404;
        response.end();
      }
    }).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  const { promise, resolve } = Promise.withResolvers<{ port: number; close: () => Promise<void> }>();
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    resolve({
      port: address.port,
      close: () => {
        const closed = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close(() => closed.resolve());
        return closed.promise;
      }
    });
  });
  return promise;
}

test('explanation is bound to stored approval, deduplicated, redacted and never executes [AC:approval-explanations#AC-2] [AC:approval-explanations#AC-4]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-explain-'));
  let calls = 0; let prompt = ''; let turns = 0;
  const runtime = new RawAgentRuntime({ repoRoot: dir, stateDir: dir, modelAdapter: {
    name: 'approval-explain', async summarizeMessages() { return ''; },
    async runTurn() { turns++; return { stopReason: 'end' as const, assistantParts: [] }; },
    async completeText(input) { calls++; prompt = input.user; await new Promise(resolve => setTimeout(resolve, 20)); return JSON.stringify({ action: '克隆仓库到临时目录，读取后清理', risk: '清理会递归删除临时目录，需核对目标路径' }); }
  }});
  const server = await listen(runtime);
  try {
    const session = runtime.store.createSession({ title: 'explain', mode: 'chat', agentId: 'general', background: false, metadata: {} });
    const args = { command: 'git clone https://example.com/repo /tmp/review; rm -rf /tmp/review', apiKey: 'private-key-value' };
    const a = runtime.store.createApproval({ sessionId: session.id, toolName: 'bash', reason: 'Auto-review (shell) blocked high-risk bash: high risk', args });
    const post = (id = a.id, locale = 'zh') => fetch(`http://127.0.0.1:${server.port}/api/approval-explanations/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale, command: 'UNTRUSTED OVERRIDE' }) });
    const responses = await Promise.all([post(), post()]);
    const bodies = await Promise.all(responses.map(r => r.json()));
    assert.equal(responses[0].status, 200);
    assert.equal(bodies[0].explanation.action, '克隆仓库到临时目录，读取后清理');
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(calls, 1);
    assert.match(prompt, /rm -rf/); assert.doesNotMatch(prompt, /private-key-value|UNTRUSTED OVERRIDE/);
    await post(); assert.equal(calls, 1);
    await post(a.id, 'en'); assert.equal(calls, 2);
    assert.equal(runtime.store.getApproval(a.id)?.status, 'pending');
    assert.deepEqual(runtime.store.getApproval(a.id)?.args, args);
    assert.equal(turns, 0);
    assert.equal(runtime.store.listMessages(session.id).length, 0);
  } finally { await server.close(); await runtime.destroy(); rmSync(dir, { recursive: true, force: true }); }
});

test('invalid or failed model explanation stays optional [AC:approval-explanations#AC-3]', async () => {
  const { createApprovalExplainer } = await import('../dist/approval-explanation.js');
  const approval = { id: 'a', toolName: 'bash', reason: 'blocked', args: { command: 'rm -rf /tmp/example' } };
  for (const complete of [async () => { throw Error('offline'); }, async () => '{}', async () => JSON.stringify({action:'ok', risk:''})]) {
    assert.equal(await createApprovalExplainer(complete)(approval, 'zh'), null);
  }
});

test('known secret values are removed even inside shell strings [AC:approval-explanations#AC-4]', async () => {
  const { createApprovalExplainer } = await import('../dist/approval-explanation.js');
  const prior = process.env.APPROVAL_EXPLAIN_TEST_TOKEN;
  process.env.APPROVAL_EXPLAIN_TEST_TOKEN = 'known-private-test-value';
  try {
    let prompt = '';
    const explain = createApprovalExplainer(async input => { prompt = input.user; return JSON.stringify({action:'download',risk:'known-private-test-value'}); });
    const result = await explain({id:'s',toolName:'bash',reason:'blocked',args:{command:'curl -H "Authorization: known-private-test-value" example.com'}},'en');
    assert.doesNotMatch(prompt, /known-private-test-value/);
    assert.doesNotMatch(result!.risk, /known-private-test-value/);
  } finally { if (prior === undefined) delete process.env.APPROVAL_EXPLAIN_TEST_TOKEN; else process.env.APPROVAL_EXPLAIN_TEST_TOKEN = prior; }
});
