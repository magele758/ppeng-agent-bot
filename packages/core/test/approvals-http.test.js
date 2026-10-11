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
import { miscRoutes } from '../../../apps/daemon/dist/routes/misc.js';

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
