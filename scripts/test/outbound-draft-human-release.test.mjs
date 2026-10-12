/**
 * Draft approve/reject is a human action.
 * The model shell inherits a sanitized env (same Tier-0 path as bash) and must not
 * be able to POST /api/outbound-drafts/:id/approve. The operator bearer alone is not enough.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuthStore, hashToken, RawAgentRuntime } from '@ppeng/agent-core';
import { SandboxManager } from '../../packages/core/dist/sandbox/os-sandbox.js';
import { createDaemonApp } from '../../apps/daemon/dist/app.js';
import { appendOutboundDraft, claimOutboundDraft, readOutboundDrafts } from '../../packages/capability-gateway/dist/outbound-drafts.js';

const idleAdapter = {
  name: 'idle',
  async runTurn() {
    return { stopReason: 'end', assistantParts: [{ type: 'text', text: 'ok' }] };
  },
  async summarizeMessages() {
    return '';
  }
};

const SHELL_SCRIPT = `
const headers = {};
if (process.env.RAW_AGENT_AUTH_TOKEN) headers.authorization = 'Bearer ' + process.env.RAW_AGENT_AUTH_TOKEN;
if (process.env.RAW_AGENT_HUMAN_RELEASE_SECRET) headers['x-ppeng-human-release'] = process.env.RAW_AGENT_HUMAN_RELEASE_SECRET;
const res = await fetch(process.env.DRAFT_APPROVE_URL, { method: 'POST', headers });
const body = await res.text();
process.stdout.write(JSON.stringify({
  status: res.status,
  body,
  sawToken: Boolean(process.env.RAW_AGENT_AUTH_TOKEN),
  sawRelease: Boolean(process.env.RAW_AGENT_HUMAN_RELEASE_SECRET)
}));
`;

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function boot(env) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'draft-auth-repo-'));
  const stateDir = mkdtempSync(join(tmpdir(), 'draft-auth-state-'));
  const runtime = new RawAgentRuntime({ repoRoot, stateDir, modelAdapter: idleAdapter });
  const authStore = new AuthStore(runtime.store.db);
  const app = createDaemonApp({
    runtime,
    authStore,
    env,
    repoRoot,
    config: { storageCtx: {}, domainsMounted: [] },
    pkgName: 'draft-auth',
    pkgVersion: '0.0.0',
    readBody: readJsonBody,
    readBodyLimit: 1_000_000
  });
  const server = createServer(async (request, response) => {
    try {
      if (!(await app.handle(request, response))) {
        response.statusCode = 404;
        response.end('no');
      }
    } catch (error) {
      if (response.headersSent) return;
      response.statusCode = error.statusCode ?? 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    runtime,
    authStore,
    base,
    gatewayDir: join(stateDir, 'gateway'),
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function modelShellApprove() {
  const scriptPath = join(tmpdir(), `draft-shell-${randomBytes(4).toString('hex')}.mjs`);
  writeFileSync(scriptPath, SHELL_SCRIPT);
  const sandbox = new SandboxManager('direct');
  try {
    const result = await sandbox.execute(`node ${JSON.stringify(scriptPath)}`, tmpdir(), {
      timeoutMs: 15_000,
      allowNetwork: true
    });
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    return JSON.parse(result.stdout);
  } finally {
    unlinkSync(scriptPath);
  }
}

test('model shell with the inherited operator env cannot approve a draft', async (t) => {
  const token = `op-${randomBytes(8).toString('hex')}`;
  const release = `hum-${randomBytes(8).toString('hex')}`;
  const daemon = await boot({
    RAW_AGENT_AUTH_TOKEN: token,
    RAW_AGENT_HUMAN_RELEASE_SECRET: release
  });
  t.after(() => daemon.close());
  const draft = await appendOutboundDraft(daemon.gatewayDir, { channelId: 'out', text: 'hold' });
  const approveUrl = `${daemon.base}/api/outbound-drafts/${draft.id}/approve`;

  const previous = {
    token: process.env.RAW_AGENT_AUTH_TOKEN,
    release: process.env.RAW_AGENT_HUMAN_RELEASE_SECRET,
    url: process.env.DRAFT_APPROVE_URL
  };
  process.env.RAW_AGENT_AUTH_TOKEN = token;
  process.env.RAW_AGENT_HUMAN_RELEASE_SECRET = release;
  process.env.DRAFT_APPROVE_URL = approveUrl;
  try {
    const shell = await modelShellApprove();
    assert.equal(shell.sawToken, false);
    assert.equal(shell.sawRelease, false);
    assert.equal(shell.status, 401);
    const still = (await readOutboundDrafts(daemon.gatewayDir)).find((item) => item.id === draft.id);
    assert.equal(still.status, 'pending_approval');
  } finally {
    if (previous.token === undefined) delete process.env.RAW_AGENT_AUTH_TOKEN;
    else process.env.RAW_AGENT_AUTH_TOKEN = previous.token;
    if (previous.release === undefined) delete process.env.RAW_AGENT_HUMAN_RELEASE_SECRET;
    else process.env.RAW_AGENT_HUMAN_RELEASE_SECRET = previous.release;
    if (previous.url === undefined) delete process.env.DRAFT_APPROVE_URL;
    else process.env.DRAFT_APPROVE_URL = previous.url;
  }

  const bearerOnly = await fetch(approveUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(bearerOnly.status, 401);
  assert.match(await bearerOnly.text(), /human_release_required/);
  assert.equal((await readOutboundDrafts(daemon.gatewayDir))[0].status, 'pending_approval');

  const human = await fetch(`${daemon.base}/api/outbound-drafts/draft_missing/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-ppeng-human-release': release }
  });
  assert.equal(human.status, 404);
});

test('listing drafts does not treat an in-flight send as a crash', async (t) => {
  const token = `op-${randomBytes(8).toString('hex')}`;
  const daemon = await boot({
    RAW_AGENT_AUTH_TOKEN: token,
    RAW_AGENT_HUMAN_RELEASE_SECRET: `hum-${randomBytes(8).toString('hex')}`
  });
  t.after(() => daemon.close());
  const draft = await appendOutboundDraft(daemon.gatewayDir, { channelId: 'out', text: 'still sending' });
  await claimOutboundDraft(daemon.gatewayDir, draft.id);
  const listed = await fetch(`${daemon.base}/api/outbound-drafts`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.drafts.find((item) => item.id === draft.id)?.status, 'sending');
  assert.equal((await readOutboundDrafts(daemon.gatewayDir))[0].status, 'sending');
});

test('with isolation off and no release secret, an unauthenticated shell still cannot approve', async (t) => {
  const daemon = await boot({});
  t.after(() => daemon.close());
  const draft = await appendOutboundDraft(daemon.gatewayDir, { channelId: 'out', text: 'hold' });
  const approveUrl = `${daemon.base}/api/outbound-drafts/${draft.id}/approve`;
  const previous = process.env.DRAFT_APPROVE_URL;
  process.env.DRAFT_APPROVE_URL = approveUrl;
  try {
    const shell = await modelShellApprove();
    assert.equal(shell.status, 401);
    assert.match(shell.body, /human_release_required/);
  } finally {
    if (previous === undefined) delete process.env.DRAFT_APPROVE_URL;
    else process.env.DRAFT_APPROVE_URL = previous;
  }
  assert.equal((await readOutboundDrafts(daemon.gatewayDir))[0].status, 'pending_approval');
});

test('a Lab login session can approve and the release header cannot bypass login', async (t) => {
  const token = `op-${randomBytes(8).toString('hex')}`;
  const release = `hum-${randomBytes(8).toString('hex')}`;
  const daemon = await boot({
    RAW_AGENT_AUTH_TOKEN: token,
    RAW_AGENT_HUMAN_RELEASE_SECRET: release,
    RAW_AGENT_OAUTH_GITHUB_CLIENT_ID: 'draft-client',
    RAW_AGENT_OAUTH_GITHUB_CLIENT_SECRET: 'draft-secret'
  });
  t.after(() => daemon.close());
  const memory = daemon.runtime.store.agentMemory();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  memory.upsertTenant({ id: 'default', name: 'Default', createdAt: new Date().toISOString() });
  memory.upsertUser({ id: 'user_admin', email: 'a@example.test', status: 'active', createdAt: new Date().toISOString() });
  memory.addMembership({ userId: 'user_admin', tenantId: 'default', role: 'admin' });
  const session = randomBytes(16).toString('hex');
  daemon.authStore.createAuthSession({
    tokenHash: hashToken(session),
    userId: 'user_admin',
    expiresAt,
    createdAt: new Date().toISOString()
  });
  const path = '/api/outbound-drafts/draft_missing/approve';
  const asUser = await fetch(daemon.base + path, {
    method: 'POST',
    headers: {
      'x-ppeng-lab': '1',
      authorization: `Bearer ${token}`,
      cookie: `ppeng_lab_session=${session}`
    }
  });
  assert.equal(asUser.status, 404);
  const headerOnly = await fetch(daemon.base + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-ppeng-human-release': release }
  });
  assert.equal(headerOnly.status, 401);
  assert.match(await headerOnly.text(), /human_release_required/);
});
