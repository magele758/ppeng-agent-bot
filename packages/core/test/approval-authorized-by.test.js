/**
 * Approval receipts persist an optional authorizedBy citation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStateStore } from '../dist/storage.js';
import { RawAgentRuntime } from '../dist/runtime.js';
import { miscRoutes } from '../../../apps/daemon/dist/routes/misc.js';

const ANON = { isolate: false, labProxy: false, user: null };

function makeStore() {
  const stateDir = mkdtempSync(join(tmpdir(), 'appr-cite-'));
  const store = new SqliteStateStore(join(stateDir, 'state.sqlite'));
  const session = store.createSession({ title: 'cite', mode: 'chat', agentId: 'general' });
  return { store, session };
}

test('a receipt keeps cited ids through approval and a later read [AC:auto-review-authorized-by#AC-1]', () => {
  const { store, session } = makeStore();
  const cols = store.db.prepare(`PRAGMA table_info(approvals)`).all();
  assert.ok(cols.some((col) => col.name === 'authorized_by_json'));
  const created = store.createApproval({
    sessionId: session.id,
    toolName: 'bash',
    reason: 'Auto-review (shell) blocked high-risk bash: pattern',
    args: { command: 'rm -rf ./build' },
    idempotencyKey: 'ar:cite',
    authorizedBy: ['tNuowner', 'tNsMcard']
  });
  assert.deepEqual(created.authorizedBy, ['tNuowner', 'tNsMcard']);
  assert.deepEqual(store.getApproval(created.id)?.authorizedBy, ['tNuowner', 'tNsMcard']);
  const approved = store.updateApproval(created.id, 'approved');
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approved.authorizedBy, ['tNuowner', 'tNsMcard']);
  assert.deepEqual(store.getApproval(created.id)?.authorizedBy, ['tNuowner', 'tNsMcard']);
  assert.deepEqual(store.listApprovals({ status: 'approved' }).find((row) => row.id === created.id)?.authorizedBy, [
    'tNuowner',
    'tNsMcard'
  ]);
  store.db.close();
});

test('a pending receipt gains a citation without opening a second row [AC:auto-review-authorized-by#AC-1]', () => {
  const { store, session } = makeStore();
  const opened = store.createApproval({
    sessionId: session.id,
    toolName: 'mcp_invoke',
    reason: 'card',
    args: { server: 0, tool: 'delete_all' },
    idempotencyKey: 'ar:fill'
  });
  assert.equal(opened.authorizedBy, undefined);
  const filled = store.createApproval({
    sessionId: session.id,
    toolName: 'mcp_invoke',
    reason: 'card',
    args: { server: 0, tool: 'delete_all' },
    idempotencyKey: 'ar:fill',
    authorizedBy: ['p-parent', 'tNuowner']
  });
  assert.equal(filled.id, opened.id);
  assert.deepEqual(filled.authorizedBy, ['p-parent', 'tNuowner']);
  const again = store.createApproval({
    sessionId: session.id,
    toolName: 'mcp_invoke',
    reason: 'card',
    args: { server: 0, tool: 'delete_all' },
    idempotencyKey: 'ar:fill',
    authorizedBy: ['tNuother']
  });
  assert.equal(again.id, opened.id);
  assert.deepEqual(again.authorizedBy, ['p-parent', 'tNuowner']);
  assert.equal(store.listApprovals().filter((row) => row.idempotencyKey === 'ar:fill').length, 1);
  store.db.close();
});

test('a receipt stays without a citation when none was given [AC:auto-review-authorized-by#AC-2]', () => {
  const { store, session } = makeStore();
  const created = store.createApproval({
    sessionId: session.id,
    toolName: 'bash',
    reason: 'card',
    args: { command: 'rm -rf ./build' },
    idempotencyKey: 'ar:omit'
  });
  assert.equal(created.authorizedBy, undefined);
  assert.equal(store.getApproval(created.id)?.authorizedBy, undefined);
  const approved = store.updateApproval(created.id, 'approved');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.authorizedBy, undefined);
  assert.equal(Object.hasOwn(approved, 'authorizedBy'), false);
  store.db.close();
});

test('a receipt keeps at most four unique stable ids [AC:auto-review-authorized-by#AC-3]', () => {
  const { store, session } = makeStore();
  const created = store.createApproval({
    sessionId: session.id,
    toolName: 'bash',
    reason: 'card',
    args: { command: 'rm -rf ./build' },
    authorizedBy: [' tNu1 ', '', 'tNu1', 'not an id', 2, 'tNsM2', 'p-3', 'tNu4', 'tNu5']
  });
  assert.deepEqual(created.authorizedBy, ['tNu1', 'tNsM2', 'p-3', 'tNu4']);
  assert.deepEqual(store.getApproval(created.id)?.authorizedBy, ['tNu1', 'tNsM2', 'p-3', 'tNu4']);
  const junk = store.createApproval({
    sessionId: session.id,
    toolName: 'bash',
    reason: 'card',
    args: { command: 'sudo reboot' },
    authorizedBy: 'tNu1'
  });
  assert.equal(junk.authorizedBy, undefined);
  const blank = store.createApproval({
    sessionId: session.id,
    toolName: 'bash',
    reason: 'card',
    args: { command: 'passwd root' },
    authorizedBy: ['', 'not an id']
  });
  assert.equal(blank.authorizedBy, undefined);
  store.db.prepare(`UPDATE approvals SET authorized_by_json = ? WHERE id = ?`).run('{', created.id);
  assert.equal(store.getApproval(created.id)?.authorizedBy, undefined);
  store.db.prepare(`UPDATE approvals SET authorized_by_json = ? WHERE id = ?`).run('   ', created.id);
  assert.equal(store.getApproval(created.id)?.authorizedBy, undefined);
  store.db.close();
});

test('GET /api/approvals returns the citation and approve keeps it [AC:auto-review-authorized-by#AC-1]', async () => {
  const runtime = new RawAgentRuntime({
    repoRoot: mkdtempSync(join(tmpdir(), 'appr-cite-repo-')),
    stateDir: mkdtempSync(join(tmpdir(), 'appr-cite-http-')),
    modelAdapter: {
      name: 'noop',
      async runTurn() {
        return { stopReason: 'end', assistantParts: [] };
      },
      async summarizeMessages() {
        return '';
      }
    }
  });
  const live = runtime.store.createSession({ title: 'http', mode: 'chat', agentId: 'general' });
  const created = runtime.store.createApproval({
    sessionId: live.id,
    toolName: 'bash',
    reason: 'Auto-review (shell) blocked high-risk bash: pattern',
    args: { command: 'rm -rf ./build' },
    authorizedBy: ['tNuowner', 'tNsMcard']
  });
  const spec = miscRoutes(runtime, { pkgName: 't', pkgVersion: '0' }).find(
    (route) => route.method === 'GET' && route.pattern === '/api/approvals'
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
    url: new URL('http://x/api/approvals'),
    parts: ['api', 'approvals'],
    params: {},
    requireParam: () => '',
    readBody: async () => ({}),
    auth: ANON
  });
  const row = payload.approvals.find((item) => item.id === created.id);
  assert.deepEqual(row.authorizedBy, ['tNuowner', 'tNsMcard']);
  const decided = miscRoutes(runtime, { pkgName: 't', pkgVersion: '0' }).find(
    (route) => route.method === 'POST' && route.pattern === '/api/approvals/:id/:decision'
  );
  assert.ok(decided);
  let approvedBody;
  const approvedResponse = {
    statusCode: 200,
    setHeader() {},
    end(text) {
      approvedBody = text ? JSON.parse(text) : undefined;
    }
  };
  await decided.handler({
    request: { headers: {} },
    response: approvedResponse,
    url: new URL(`http://x/api/approvals/${created.id}/approve`),
    parts: ['api', 'approvals', created.id, 'approve'],
    params: { id: created.id, decision: 'approve' },
    requireParam: (name) => (name === 'id' ? created.id : 'approve'),
    readBody: async () => ({}),
    auth: ANON
  });
  assert.equal(approvedBody.approval.status, 'approved');
  assert.deepEqual(approvedBody.approval.authorizedBy, ['tNuowner', 'tNsMcard']);
  runtime.store.db.close();
});
