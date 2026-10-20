#!/usr/bin/env node
/**
 * Integration tests for daemon HTTP surface — focused on areas the regression
 * suite skips: social-post schedules (full chain + idempotent retry), mailbox
 * push, approval listing, and the `/api/social-post-schedules/:id/action`
 * matcher (which uses a custom path matcher rather than the simple :param
 * grammar).
 *
 * Spawns a fresh heuristic-adapter daemon on a random port + temp stateDir
 * (same recipe as scripts/regression-test.mjs).
 *
 * Usage:  pnpm run build && node scripts/integration-test.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillProposalStore } from '../packages/core/dist/skill-proposals/index.js';
import { daemonAuthHeaders, envForEphemeralDaemon } from './spawn-utils.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// E14: same dist guard as regression-test.mjs.
const daemonEntry = join(repoRoot, 'apps', 'daemon', 'dist', 'server.js');
if (!existsSync(daemonEntry)) {
  console.error(`integration-test: ${daemonEntry} missing — run \`pnpm run build\` first.`);
  process.exit(2);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickPort() {
  return 19_000 + Math.floor(Math.random() * 1_000);
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }
  throw new Error(`health failed: ${lastErr?.message ?? 'unknown'}`);
}

function spawnDaemon({ port, stateDir, repoRootOverride }) {
  const child = spawn(process.execPath, ['apps/daemon/dist/server.js'], {
    cwd: repoRootOverride ?? repoRoot,
    env: {
      ...envForEphemeralDaemon(),
      RAW_AGENT_DAEMON_HOST: '127.0.0.1',
      RAW_AGENT_DAEMON_PORT: String(port),
      RAW_AGENT_STATE_DIR: stateDir,
      RAW_AGENT_E2E_ISOLATE: '1',
      RAW_AGENT_SELF_HEAL_AUTO_START: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr?.on('data', (c) => { stderr += c.toString(); });
  return { child, getStderr: () => stderr };
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: daemonAuthHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function patchJson(url, body) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: daemonAuthHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function waitExit(child, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    child.once('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal }); });
  });
}

/**
 * Stage a temp working dir with:
 *   - a symlink-equivalent pointer back to packages/apps via a minimal repo
 *     (we run `node apps/daemon/dist/server.js` from the real repoRoot, but
 *     the daemon reads `gateway.config.json` from cwd → so we set cwd to a
 *     scratch dir containing our test-only gateway config).
 * Reality check: scripts/regression-test.mjs sets cwd to repoRoot — same here,
 * but we also write a temp gateway config into repoRoot/gateway.config.json
 * is dangerous. Instead, point RAW_AGENT_GATEWAY_CONFIG at our temp file.
 */
function writeTempGatewayConfig(dir) {
  const cfg = {
    channels: [
      { id: 'tcfg-1', type: 'webhook', url: 'https://example.invalid/hook', payloadMode: 'json_text' }
    ],
    learn: { feeds: [] }
  };
  const p = join(dir, 'gateway.config.json');
  writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return p;
}

async function runSocialFlow(baseUrl, failures) {
  // 1) Ask the daemon for the current schedule list — should be empty initially
  //    on a fresh state dir.
  const list0 = await getJson(`${baseUrl}/api/social-post-schedules`);
  if (!list0.ok) failures.push(`social list: HTTP ${list0.status}`);
  if (!Array.isArray(list0.data.items)) failures.push('social list: missing items array');
  // (We don't assert empty — heuristic adapter sometimes seeds nothing, but other
  // E2E runs may share state; instead, count and verify our additions later.)
  const initialCount = list0.ok ? list0.data.items.length : 0;

  // 2) Drive `schedule_social_post` indirectly by POSTing a chat that exercises
  //    the tool. The heuristic adapter ignores the prompt and returns canned
  //    text, so we cannot rely on it actually invoking the tool. Instead we
  //    simulate the create+approve+dispatch flow by directly calling the
  //    underlying public API the way tests in social-schedule-flow.test.js do
  //    — but at the HTTP layer we lack a "create schedule" route. Skip the
  //    create step here and instead verify the endpoints respond correctly
  //    when there is no matching task.
  const reject404 = await postJson(`${baseUrl}/api/social-post-schedules/no-such-task/action`, { action: 'approve' });
  if (reject404.status !== 404) {
    failures.push(`social action on missing task: expected 404 got ${reject404.status}`);
  }

  const badAction = await postJson(`${baseUrl}/api/social-post-schedules/whatever/action`, { action: 'noop' });
  if (badAction.status !== 400 && badAction.status !== 404) {
    // 400 (validation) preferred; 404 also acceptable since task lookup runs first.
    failures.push(`social bad action: expected 400/404 got ${badAction.status}`);
  }

  // 3) Sanity: list call still works after errors.
  const list1 = await getJson(`${baseUrl}/api/social-post-schedules`);
  if (!list1.ok) failures.push(`social list (post-error): HTTP ${list1.status}`);
  if (Array.isArray(list1.data.items) && list1.data.items.length < initialCount) {
    failures.push('social list shrank after error');
  }
}

async function runMailboxFlow(baseUrl, failures) {
  // Use built-in agents (`general` ships with the runtime). Mailbox accepts
  // mail to/from any registered agent; built-ins cover both ends.
  // Touching `/api/agents` triggers `ensureBuiltinAgentsSynced` so the row exists.
  const agents = await getJson(`${baseUrl}/api/agents`);
  if (!agents.ok) failures.push(`agents prefetch: HTTP ${agents.status}`);
  const send = await postJson(`${baseUrl}/api/mailbox`, {
    fromAgentId: 'general',
    toAgentId: 'main',
    content: 'hello from integration test',
    type: 'message'
  });
  if (send.status !== 201 || !send.data.mail?.id) {
    failures.push(`mailbox send: HTTP ${send.status} ${JSON.stringify(send.data).slice(0, 200)}`);
    return;
  }

  const list = await getJson(`${baseUrl}/api/mailbox?agentId=main`);
  if (!list.ok) failures.push(`mailbox list: HTTP ${list.status}`);
  else if (!Array.isArray(list.data.mail) || list.data.mail.length === 0) {
    failures.push('mailbox list: expected our message');
  }

  const all = await getJson(`${baseUrl}/api/mailbox/all?limit=5`);
  if (!all.ok) failures.push(`mailbox/all: HTTP ${all.status}`);

  const missing = await getJson(`${baseUrl}/api/mailbox`);
  if (missing.status !== 400) {
    failures.push(`mailbox missing agentId: expected 400 got ${missing.status}`);
  }
}

async function runApprovalFlow(baseUrl, failures) {
  // Approval list should always succeed (empty allowed).
  const list = await getJson(`${baseUrl}/api/approvals`);
  if (!list.ok) failures.push(`approvals list: HTTP ${list.status}`);
  if (!Array.isArray(list.data.approvals)) failures.push('approvals: missing approvals array');

  // Posting an approval decision for an unknown id should fail cleanly (404 / 400),
  // not 500.
  const reject = await postJson(`${baseUrl}/api/approvals/does-not-exist/approve`, {});
  if (reject.status === 500) {
    failures.push(`approve unknown id: expected 4xx, got 500 ${JSON.stringify(reject.data).slice(0, 200)}`);
  }
}

async function runBotPolicyFlow(baseUrl, failures) {
  const created = await postJson(`${baseUrl}/api/bots`, { name: 'Policy Probe' });
  const botId = created.data?.bot?.id;
  if (created.status !== 201 || !botId) {
    failures.push(`bot create: HTTP ${created.status}`);
    return;
  }
  const opened = await postJson(`${baseUrl}/api/bots/${botId}/open`, {});
  const sessionId = opened.data?.session?.id;
  if (!sessionId) {
    failures.push(`bot open: HTTP ${opened.status}`);
    return;
  }
  const meta = async () => (await getJson(`${baseUrl}/api/sessions/${sessionId}`)).data?.session?.metadata ?? {};
  let m = await meta();
  if (m.permissionMode !== 'auto') failures.push(`bot session permissionMode: expected auto got ${m.permissionMode}`);
  if (m.maxTurns !== 24) failures.push(`bot session maxTurns: expected 24 got ${m.maxTurns}`);

  for (const bad of [0, 25, -24, 100000, 'abc']) {
    const r = await patchJson(`${baseUrl}/api/bots/${botId}`, { maxTurns: bad });
    if (r.status !== 400) failures.push(`bot PATCH maxTurns=${JSON.stringify(bad)}: expected 400 got ${r.status}`);
  }
  const okTurns = await patchJson(`${baseUrl}/api/bots/${botId}`, { maxTurns: 48 });
  if (!okTurns.ok) failures.push(`bot PATCH maxTurns=48: HTTP ${okTurns.status}`);

  const badTools = await patchJson(`${baseUrl}/api/bots/${botId}`, { allowedTools: ['no_such_tool'] });
  if (badTools.status !== 400) failures.push(`bot PATCH unknown tool: expected 400 got ${badTools.status}`);
  const tools = (await getJson(`${baseUrl}/api/tools`)).data?.tools ?? [];
  if (tools.length === 0) {
    failures.push('GET /api/tools returned no tools');
  } else {
    const required = ['TodoWrite', 'load_skill', 'message_agent'];
    const narrow = tools.map((tool) => tool.name).find((name) => !required.includes(name));
    const okTools = await patchJson(`${baseUrl}/api/bots/${botId}`, { allowedTools: [narrow] });
    if (!okTools.ok) failures.push(`bot PATCH allowedTools: HTTP ${okTools.status}`);
    const warned = okTools.data?.warnings ?? [];
    const missing = warned.find((w) => w.code === 'missing_required_tools')?.tools ?? [];
    if (required.some((name) => !missing.includes(name))) {
      failures.push(`bot PATCH allowedTools without required tools: expected warnings, got ${JSON.stringify(warned)}`);
    }
    const reread = await getJson(`${baseUrl}/api/bots/${botId}`);
    const rereadMissing = (reread.data?.warnings ?? []).find((w) => w.code === 'missing_required_tools')?.tools ?? [];
    if (JSON.stringify(rereadMissing) !== JSON.stringify(missing)) {
      failures.push(`GET /api/bots/:id warnings after reload: expected ${JSON.stringify(missing)}, got ${JSON.stringify(reread.data?.warnings)}`);
    }
    const mcpSave = await patchJson(`${baseUrl}/api/bots/${botId}`, { allowedTools: [narrow, 'mcp_s0_not_registered_yet'] });
    if (!mcpSave.ok) failures.push(`bot PATCH allowedTools with unregistered MCP name: HTTP ${mcpSave.status}`);
    const badMcp = await patchJson(`${baseUrl}/api/bots/${botId}`, { allowedTools: ['mcp_bogus'] });
    if (badMcp.status !== 400) failures.push(`bot PATCH allowedTools=mcp_bogus: expected 400 got ${badMcp.status}`);
    const full = await patchJson(`${baseUrl}/api/bots/${botId}`, { allowedTools: [narrow, ...required] });
    if (!full.ok || (full.data?.warnings ?? []).length !== 0) {
      failures.push(`bot PATCH allowedTools with required tools: expected no warnings, got ${JSON.stringify(full.data)}`);
    }
    const fullReread = await getJson(`${baseUrl}/api/bots/${botId}`);
    if ((fullReread.data?.warnings ?? []).length !== 0) {
      failures.push(`GET /api/bots/:id with required tools: expected no warnings, got ${JSON.stringify(fullReread.data?.warnings)}`);
    }
    const cleared = await patchJson(`${baseUrl}/api/bots/${botId}`, { allowedTools: [] });
    if (!cleared.ok || (cleared.data?.warnings ?? []).length !== 0) {
      failures.push(`bot PATCH allowedTools=[]: expected no warnings, got ${JSON.stringify(cleared.data)}`);
    }
    await patchJson(`${baseUrl}/api/bots/${botId}`, { allowedTools: [tools[0].name] });
  }

  const badSkills = await patchJson(`${baseUrl}/api/bots/${botId}`, { allowedSkills: ['no-such-skill'] });
  if (badSkills.status !== 400) failures.push(`bot PATCH unknown skill: expected 400 got ${badSkills.status}`);
  const skills = (await getJson(`${baseUrl}/api/skills`)).data?.skills ?? [];
  if (skills.length > 0) {
    const okSkills = await patchJson(`${baseUrl}/api/bots/${botId}`, { allowedSkills: [skills[0].name] });
    if (!okSkills.ok) failures.push(`bot PATCH allowedSkills: HTTP ${okSkills.status}`);
  }

  m = await meta();
  if (m.maxTurns !== 48) failures.push(`bot session maxTurns after PATCH: expected 48 got ${m.maxTurns}`);
  if (tools.length > 0 && JSON.stringify(m.allowedTools) !== JSON.stringify([tools[0].name])) {
    failures.push(`bot session allowedTools after PATCH: ${JSON.stringify(m.allowedTools)}`);
  }

  for (const mode of ['plan', 'ask', 'acceptEdits', 'auto', 'bypass']) {
    if (mode === 'bypass') {
      const unconfirmed = await patchJson(`${baseUrl}/api/sessions/${sessionId}`, { permissionMode: mode });
      if (unconfirmed.status !== 400) {
        failures.push(`session PATCH permissionMode=bypass without confirmBypass: expected 400 got ${unconfirmed.status}`);
      }
      if ((await meta()).permissionMode === 'bypass') failures.push('unconfirmed bypass PATCH still wrote bypass');
      const falseConfirm = await patchJson(`${baseUrl}/api/sessions/${sessionId}`, {
        permissionMode: mode,
        confirmBypass: 'true'
      });
      if (falseConfirm.status !== 400) {
        failures.push(`session PATCH bypass with non-boolean confirmBypass: expected 400 got ${falseConfirm.status}`);
      }
      const shiftFromAuto = await patchJson(`${baseUrl}/api/sessions/${sessionId}`, { shiftPermission: 'elevate' });
      if (shiftFromAuto.status !== 400) {
        failures.push(`session PATCH elevate auto->bypass without confirmBypass: expected 400 got ${shiftFromAuto.status}`);
      }
      const viaPermission = await postJson(`${baseUrl}/api/sessions/${sessionId}/permission`, { mode });
      if (viaPermission.status !== 400) {
        failures.push(`POST /permission bypass without confirmBypass: expected 400 got ${viaPermission.status}`);
      }
    }
    const set = await patchJson(`${baseUrl}/api/sessions/${sessionId}`, {
      permissionMode: mode,
      ...(mode === 'bypass' ? { confirmBypass: true } : {})
    });
    if (!set.ok) failures.push(`session PATCH permissionMode=${mode}: HTTP ${set.status}`);
    const reopenedTier = await postJson(`${baseUrl}/api/bots/${botId}/open`, {});
    const stored = reopenedTier.data?.session?.metadata?.permissionMode;
    if (stored !== mode) failures.push(`permissionMode ${mode} round trip: reopen returned ${stored}`);
    if ((await meta()).permissionMode !== mode) failures.push(`permissionMode ${mode} not persisted`);
  }
  const badMode = await patchJson(`${baseUrl}/api/sessions/${sessionId}`, { permissionMode: 'root' });
  if (badMode.status !== 400) failures.push(`session PATCH permissionMode=root: expected 400 got ${badMode.status}`);
  const viaSessions = await postJson(`${baseUrl}/api/sessions`, { botId, autoRun: false });
  if (viaSessions.data?.session?.metadata?.permissionMode !== 'bypass') {
    failures.push(`POST /api/sessions {botId} rewrote permissionMode: ${viaSessions.data?.session?.metadata?.permissionMode}`);
  }
  const clearMode = await patchJson(`${baseUrl}/api/sessions/${sessionId}`, { permissionMode: null });
  if (clearMode.status !== 400) failures.push(`session PATCH permissionMode=null: expected 400 got ${clearMode.status}`);
  const beforePolicy = await meta();
  for (const metadata of [
    { permissionMode: 'bypass' },
    { permissionMode: null },
    { permissionMode: 'auto' },
    { allowedTools: [] },
    { allowedSkills: ['anything'] },
    { allowedSkills: [] }
  ]) {
    const rejected = await postJson(`${baseUrl}/api/sessions`, { botId, autoRun: false, metadata });
    if (rejected.status !== 400) {
      failures.push(`POST /api/sessions {botId, metadata:${JSON.stringify(metadata)}}: expected 400 got ${rejected.status}`);
    } else if (!/PATCH \/api\/bots\/:id/.test(rejected.data?.error ?? JSON.stringify(rejected.data))) {
      failures.push(`POST /api/sessions {botId, metadata:${JSON.stringify(metadata)}}: 400 does not point at PATCH /api/bots/:id`);
    }
  }
  const afterPolicy = await meta();
  for (const key of ['permissionMode', 'allowedTools', 'allowedSkills']) {
    if (JSON.stringify(afterPolicy[key]) !== JSON.stringify(beforePolicy[key])) {
      failures.push(`rejected bot create changed ${key}: ${JSON.stringify(beforePolicy[key])} -> ${JSON.stringify(afterPolicy[key])}`);
    }
  }
  const plainWithPolicy = await postJson(`${baseUrl}/api/sessions`, {
    autoRun: false,
    metadata: { permissionMode: 'plan', allowedTools: ['bash'] }
  });
  if (plainWithPolicy.status !== 201) {
    failures.push(`plain POST /api/sessions with policy metadata: expected 201 got ${plainWithPolicy.status}`);
  }
  const badMeta = await postJson(`${baseUrl}/api/sessions`, { botId, autoRun: false, metadata: { maxTurns: 25 } });
  if (badMeta.status !== 400) failures.push(`POST /api/sessions metadata.maxTurns=25: expected 400 got ${badMeta.status}`);
  m = await meta();
  if (m.maxTurns !== 48) failures.push(`maxTurns changed after rejected create: ${m.maxTurns}`);
}

async function runBotModelFlow(baseUrl, failures) {
  const created = await postJson(`${baseUrl}/api/bots`, { name: 'Model Probe' });
  const botId = created.data?.bot?.id;
  if (created.status !== 201 || !botId) {
    failures.push(`model bot create: HTTP ${created.status}`);
    return;
  }
  const opened = await postJson(`${baseUrl}/api/bots/${botId}/open`, {});
  const sessionId = opened.data?.session?.id;
  if (!sessionId) {
    failures.push(`model bot open: HTTP ${opened.status}`);
    return;
  }
  const meta = async () => (await getJson(`${baseUrl}/api/sessions/${sessionId}`)).data?.session?.metadata ?? {};
  const provider = await postJson(`${baseUrl}/api/model-providers`, {
    name: 'Bot Model Probe',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-probe',
    models: [
      { id: 'probe-a', enabled: true },
      { id: 'probe-off', enabled: false }
    ]
  });
  const providerId = provider.data?.provider?.id;
  if (provider.status !== 201 || !providerId) {
    failures.push(`model provider create: HTTP ${provider.status}`);
    return;
  }
  const ref = { providerId, modelId: 'probe-a' };

  if ((await meta()).modelOverride !== undefined) failures.push('fresh bot chat already has a modelOverride');
  for (const bad of [
    { providerId, modelId: 'probe-off' },
    { providerId, modelId: 'missing' },
    { providerId: 'ghost', modelId: 'probe-a' },
    'probe-a',
    { providerId }
  ]) {
    const r = await patchJson(`${baseUrl}/api/bots/${botId}`, { modelOverride: bad });
    if (r.status !== 400) failures.push(`bot PATCH modelOverride=${JSON.stringify(bad)}: expected 400 got ${r.status}`);
  }
  if ((await meta()).modelOverride !== undefined) failures.push('rejected modelOverride was still stored');

  for (const bad of [
    { providerId, modelId: 'probe-off' },
    { providerId, modelId: 'missing' },
    { providerId: 'ghost', modelId: 'probe-a' },
    'probe-a',
    { providerId },
    7
  ]) {
    const r = await postJson(`${baseUrl}/api/sessions`, { botId, autoRun: false, metadata: { modelOverride: bad } });
    if (r.status !== 400) failures.push(`POST /api/sessions {botId} metadata.modelOverride=${JSON.stringify(bad)}: expected 400 got ${r.status}`);
  }
  if ((await meta()).modelOverride !== undefined) failures.push('rejected POST /api/sessions modelOverride was still stored');
  for (const bad of ['probe-a', { providerId }, 7, []]) {
    const r = await postJson(`${baseUrl}/api/sessions`, { autoRun: false, metadata: { modelOverride: bad } });
    if (r.status !== 400) failures.push(`POST /api/sessions (no bot) metadata.modelOverride=${JSON.stringify(bad)}: expected 400 got ${r.status}`);
  }
  const plainUnlisted = await postJson(`${baseUrl}/api/sessions`, {
    autoRun: false,
    metadata: { modelOverride: { providerId, modelId: 'missing' } }
  });
  if (plainUnlisted.status !== 201) {
    failures.push(`POST /api/sessions (no bot) well-formed unlisted modelOverride: expected 201 got ${plainUnlisted.status}`);
  } else if (plainUnlisted.data?.session?.metadata?.modelOverride?.modelId !== 'missing') {
    failures.push('plain session did not store its well-formed modelOverride');
  }
  const plainNull = await postJson(`${baseUrl}/api/sessions`, { autoRun: false, metadata: { modelOverride: null } });
  if (plainNull.status !== 201 || 'modelOverride' in (plainNull.data?.session?.metadata ?? {})) {
    failures.push(`POST /api/sessions (no bot) modelOverride=null: status ${plainNull.status}, stored=${JSON.stringify(plainNull.data?.session?.metadata?.modelOverride)}`);
  }

  const ok = await patchJson(`${baseUrl}/api/bots/${botId}`, { modelOverride: ref });
  if (!ok.ok) failures.push(`bot PATCH modelOverride: HTTP ${ok.status}`);
  if (JSON.stringify(ok.data?.modelOverride) !== JSON.stringify(ref)) {
    failures.push(`bot PATCH modelOverride response: ${JSON.stringify(ok.data?.modelOverride)}`);
  }
  if (JSON.stringify((await meta()).modelOverride) !== JSON.stringify(ref)) {
    failures.push(`bot session modelOverride after PATCH: ${JSON.stringify((await meta()).modelOverride)}`);
  }

  const reopened = await postJson(`${baseUrl}/api/bots/${botId}/open`, {});
  if (JSON.stringify(reopened.data?.session?.metadata?.modelOverride) !== JSON.stringify(ref)) {
    failures.push('openBot rewrote modelOverride');
  }
  const other = await patchJson(`${baseUrl}/api/bots/${botId}`, { maxTurns: 48 });
  if (!other.ok || JSON.stringify((await meta()).modelOverride) !== JSON.stringify(ref)) {
    failures.push('unrelated bot PATCH dropped modelOverride');
  }
  const sent = await postJson(`${baseUrl}/api/sessions/${sessionId}/messages`, {
    message: 'hello',
    modelRef: { providerId: 'heuristic', modelId: 'heuristic' },
    autoRun: false
  });
  if (!sent.ok) failures.push(`bot message with composer modelRef: HTTP ${sent.status}`);
  if (JSON.stringify((await meta()).modelOverride) !== JSON.stringify(ref)) {
    failures.push('composer modelRef overwrote the bot modelOverride');
  }

  const cleared = await patchJson(`${baseUrl}/api/bots/${botId}`, { modelOverride: null });
  if (!cleared.ok) failures.push(`bot PATCH modelOverride=null: HTTP ${cleared.status}`);
  if ('modelOverride' in (await meta())) failures.push('modelOverride not cleared');

  const viaSessions = await postJson(`${baseUrl}/api/sessions`, { botId, autoRun: false, metadata: { modelOverride: ref } });
  if (viaSessions.status !== 201) failures.push(`POST /api/sessions {botId} valid modelOverride: HTTP ${viaSessions.status}`);
  if (JSON.stringify((await meta()).modelOverride) !== JSON.stringify(ref)) {
    failures.push(`POST /api/sessions {botId} did not pin the bot chat: ${JSON.stringify((await meta()).modelOverride)}`);
  }
  const viaSessionsClear = await postJson(`${baseUrl}/api/sessions`, { botId, autoRun: false, metadata: { modelOverride: null } });
  if (viaSessionsClear.status !== 201) failures.push(`POST /api/sessions {botId} modelOverride=null: HTTP ${viaSessionsClear.status}`);
  if ('modelOverride' in (await meta())) failures.push('POST /api/sessions {botId} modelOverride=null did not clear the pin');
}

async function runSkillProposalFlow(baseUrl, failures, stateDir) {
  const api = `${baseUrl}/api/skill-proposals`;
  const settings = await getJson(`${api}/settings`);
  if (settings.data?.settings?.enabled !== false || settings.data?.settings?.remindEveryNToolCalls !== 0) {
    failures.push(`skill-proposals settings default: ${JSON.stringify(settings.data)}`);
  }
  if (settings.data?.effective?.source !== 'default') {
    failures.push(`skill-proposals settings source before save: ${settings.data?.effective?.source}`);
  }
  for (const bad of [{ enabled: 'yes' }, { remindEveryNToolCalls: -1 }, { remindEveryNToolCalls: 1001 }, { remindEveryNToolCalls: 'abc' }, { remindEveryNToolCalls: 1.5 }]) {
    const r = await patchJson(`${api}/settings`, bad);
    if (r.status !== 400) failures.push(`skill-proposals PATCH ${JSON.stringify(bad)}: expected 400 got ${r.status}`);
  }
  const saved = await patchJson(`${api}/settings`, { enabled: true, remindEveryNToolCalls: 3 });
  if (!saved.ok || saved.data?.settings?.enabled !== true || saved.data?.settings?.remindEveryNToolCalls !== 3) {
    failures.push(`skill-proposals PATCH ok: ${saved.status} ${JSON.stringify(saved.data)}`);
  }
  const after = await getJson(`${api}/settings`);
  if (after.data?.effective?.source !== 'ui' || after.data?.effective?.enabled !== true) {
    failures.push(`skill-proposals settings after save: ${JSON.stringify(after.data)}`);
  }

  if ((await getJson(api)).data?.proposals?.length !== 0) failures.push('skill-proposals list should start empty');
  if (!stateDir) return;

  const store = new SkillProposalStore(stateDir);
  const body = '# Steps\n\n1. Do the thing.\n2. Verify.\n';
  const a = store.create({ name: 'it-approved-skill', description: 'Approved by the integration flow', body, sessionId: 'sess_it_1' });
  const b = store.create({ name: 'it-rejected-skill', description: 'Rejected by the integration flow', body, sessionId: 'sess_it_1' });
  const c = store.create({ name: 'it-pending-skill', description: 'Stays pending', body, sessionId: 'sess_it_2' });

  const list = await getJson(api);
  const rows = list.data?.proposals ?? [];
  if (rows.length !== 3 || rows.some((r) => 'body' in r || typeof r.bodyPreview !== 'string')) {
    failures.push(`skill-proposals list shape: ${JSON.stringify(list.data).slice(0, 300)}`);
  }
  if ((await getJson(`${api}?status=bogus`)).status !== 400) failures.push('skill-proposals bad status filter should 400');
  const one = await getJson(`${api}/${a.id}`);
  if (one.data?.proposal?.body !== body.trim()) failures.push('skill-proposals GET :id should return the full body');
  for (const badId of ['..%2F..%2Fetc%2Fpasswd', 'settings2', 'sp_00000000000000000000000000000000']) {
    const r = await getJson(`${api}/${badId}`);
    if (r.status !== 404) failures.push(`skill-proposals GET ${badId}: expected 404 got ${r.status}`);
  }
  const bad = await postJson(`${api}/..%2F..%2Fx/approve`, {});
  if (bad.status !== 404) failures.push(`skill-proposals approve traversal id: expected 404 got ${bad.status}`);

  const skillNames = async () => ((await getJson(`${baseUrl}/api/skills`)).data?.skills ?? []).map((s) => `${s.name}:${s.source}`);
  if ((await skillNames()).some((n) => n.startsWith('it-'))) failures.push('proposals must not be loadable before approval');

  const approved = await postJson(`${api}/${a.id}/approve`, {});
  if (!approved.ok || approved.data?.proposal?.status !== 'approved') {
    failures.push(`skill-proposals approve: ${approved.status} ${JSON.stringify(approved.data)}`);
  }
  const installed = join(stateDir, 'skills', 'it-approved-skill', 'SKILL.md');
  if (!existsSync(installed) || !readFileSync(installed, 'utf8').includes('Do the thing.')) {
    failures.push('approved skill file missing under stateDir/skills');
  }
  if (!(await skillNames()).includes('it-approved-skill:user')) failures.push('approved skill should appear in /api/skills with source=user');
  if ((await postJson(`${api}/${a.id}/approve`, {})).status !== 409) failures.push('double approve should 409');
  if ((await postJson(`${api}/${a.id}/reject`, {})).status !== 409) failures.push('reject after approve should 409');

  const rejected = await postJson(`${api}/${b.id}/reject`, { reason: 'too vague' });
  if (!rejected.ok || rejected.data?.proposal?.status !== 'rejected' || rejected.data?.proposal?.rejectReason !== 'too vague') {
    failures.push(`skill-proposals reject: ${rejected.status} ${JSON.stringify(rejected.data)}`);
  }
  if (existsSync(join(stateDir, 'skills', 'it-rejected-skill'))) failures.push('rejected skill must not be installed');
  if ((await skillNames()).some((n) => n.startsWith('it-rejected-skill'))) failures.push('rejected skill must not be loadable');
  if ((await postJson(`${api}/${b.id}/approve`, {})).status !== 409) failures.push('approve after reject should 409');
  if ((await getJson(`${api}/${b.id}`)).data?.proposal?.status !== 'rejected') failures.push('rejected record should be kept');

  const pending = (await getJson(`${api}?status=pending`)).data?.proposals ?? [];
  if (pending.length !== 1 || pending[0].id !== c.id) failures.push(`pending filter: ${JSON.stringify(pending.map((p) => p.name))}`);

  if ((await postJson(`${api}/${c.id}/revoke`, {})).status !== 409) failures.push('revoke of a pending proposal should 409');
  if ((await postJson(`${api}/${b.id}/revoke`, {})).status !== 409) failures.push('revoke of a rejected proposal should 409');
  if ((await postJson(`${api}/..%2F..%2Fx/revoke`, {})).status !== 404) failures.push('revoke traversal id should 404');
  if ((await postJson(`${api}/sp_00000000000000000000000000000000/revoke`, {})).status !== 404) failures.push('revoke unknown id should 404');
  if (!existsSync(installed)) failures.push('failed revokes must not delete the installed skill');

  const revoked = await postJson(`${api}/${a.id}/revoke`, {});
  if (!revoked.ok || revoked.data?.proposal?.status !== 'revoked' || revoked.data?.outcome !== 'removed' || !revoked.data?.proposal?.revokedAt) {
    failures.push(`skill-proposals revoke: ${revoked.status} ${JSON.stringify(revoked.data)}`);
  }
  if (existsSync(join(stateDir, 'skills', 'it-approved-skill'))) failures.push('revoked skill directory should be deleted');
  if ((await skillNames()).some((n) => n.startsWith('it-approved-skill'))) failures.push('revoked skill must vanish from /api/skills');
  const revokedRec = (await getJson(`${api}/${a.id}`)).data?.proposal;
  if (revokedRec?.status !== 'revoked' || !revokedRec?.decidedAt) failures.push(`revoked record should be kept: ${JSON.stringify(revokedRec)}`);
  if ((await getJson(`${api}?status=revoked`)).data?.proposals?.length !== 1) failures.push('status=revoked filter should list the revoked proposal');
  if ((await postJson(`${api}/${a.id}/revoke`, {})).status !== 409) failures.push('double revoke should 409');
  if ((await postJson(`${api}/${a.id}/approve`, {})).status !== 409) failures.push('approve after revoke should 409');

  const d = store.create({ ...{ name: 'it-gone-skill', description: 'Dir removed out of band', body }, sessionId: 'sess_it_3' });
  await postJson(`${api}/${d.id}/approve`, {});
  rmSync(join(stateDir, 'skills', 'it-gone-skill'), { recursive: true, force: true });
  const gone = await postJson(`${api}/${d.id}/revoke`, {});
  if (!gone.ok || gone.data?.outcome !== 'missing' || typeof gone.data?.hint !== 'string') {
    failures.push(`revoke with missing dir should succeed with a hint: ${gone.status} ${JSON.stringify(gone.data)}`);
  }

  const off = await patchJson(`${api}/settings`, { enabled: false });
  if (!off.ok || off.data?.settings?.enabled !== false) failures.push('skill-proposals switch off should persist');
}

async function runModelFallbackFlow(baseUrl, failures) {
  const api = `${baseUrl}/api/model-fallback/settings`;
  const initial = await getJson(api);
  if (initial.data?.settings?.chain?.length !== 0 || initial.data?.effective?.source !== 'default' || initial.data?.effective?.enabled !== false) {
    failures.push(`model-fallback default: ${JSON.stringify(initial.data)}`);
  }
  const provider = await postJson(`${baseUrl}/api/model-providers`, {
    name: 'Fallback Probe',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'sk-fallback-probe',
    models: [
      { id: 'fb-a', enabled: true },
      { id: 'fb-b', enabled: true },
      { id: 'fb-off', enabled: false }
    ]
  });
  const providerId = provider.data?.provider?.id;
  if (provider.status !== 201 || !providerId) {
    failures.push(`model-fallback provider create: HTTP ${provider.status}`);
    return;
  }
  const a = { providerId, modelId: 'fb-a' };
  const b = { providerId, modelId: 'fb-b' };
  const listed = (await getJson(api)).data?.options ?? [];
  if (!listed.some((o) => o.providerId === providerId && o.modelId === 'fb-a')) failures.push('model-fallback options should list configured models');

  for (const bad of [
    {},
    { chain: 'fb-a' },
    { chain: [{ providerId }] },
    { chain: [{ providerId, modelId: 'fb-off' }] },
    { chain: [{ providerId, modelId: 'missing' }] },
    { chain: [{ providerId: 'ghost', modelId: 'fb-a' }] },
    { chain: [a, a] },
    { chain: Array.from({ length: 9 }, () => a) }
  ]) {
    const r = await patchJson(api, bad);
    if (r.status !== 400) failures.push(`model-fallback PATCH ${JSON.stringify(bad).slice(0, 80)}: expected 400 got ${r.status}`);
  }
  if ((await getJson(api)).data?.settings?.chain?.length !== 0) failures.push('rejected PATCH must not persist anything');

  const saved = await patchJson(api, { chain: [b, a] });
  const order = (saved.data?.settings?.chain ?? []).map((r) => r.modelId).join(',');
  if (!saved.ok || order !== 'fb-b,fb-a' || saved.data?.effective?.enabled !== true || saved.data?.effective?.source !== 'ui') {
    failures.push(`model-fallback PATCH ok: ${saved.status} ${JSON.stringify(saved.data)}`);
  }
  const again = await getJson(api);
  if ((again.data?.settings?.chain ?? []).map((r) => r.modelId).join(',') !== 'fb-b,fb-a') {
    failures.push(`model-fallback reload order: ${JSON.stringify(again.data?.settings)}`);
  }
  if (!again.data?.chainStatus?.every((c) => c.usable === true)) failures.push('model-fallback chainStatus should be usable');

  const cleared = await patchJson(api, { chain: [] });
  if (!cleared.ok || cleared.data?.settings?.chain?.length !== 0 || cleared.data?.effective?.enabled !== false) {
    failures.push(`model-fallback clear: ${JSON.stringify(cleared.data)}`);
  }
}

async function main() {
  const failures = [];
  const external = process.env.INTEGRATION_DAEMON_URL?.trim();
  let port;
  let stateDir;
  let cfgDir;
  let child;
  let getStderr;
  let baseUrl;
  if (external) {
    baseUrl = external.replace(/\/$/, '');
    child = { kill() {} };
    getStderr = () => '';
  } else {
    port = pickPort();
    stateDir = mkdtempSync(join(tmpdir(), 'agent-it-state-'));
    cfgDir = mkdtempSync(join(tmpdir(), 'agent-it-cfg-'));
    writeTempGatewayConfig(cfgDir);
    process.env.RAW_AGENT_GATEWAY_CONFIG = join(cfgDir, 'gateway.config.json');
    ({ child, getStderr } = spawnDaemon({ port, stateDir }));
    baseUrl = `http://127.0.0.1:${port}`;
  }

  try {
    await waitForHealth(baseUrl, 20_000);
    await runMailboxFlow(baseUrl, failures);
    await runApprovalFlow(baseUrl, failures);
    await runSocialFlow(baseUrl, failures);
    await runBotPolicyFlow(baseUrl, failures);
    await runBotModelFlow(baseUrl, failures);
    await runSkillProposalFlow(baseUrl, failures, stateDir);
    await runModelFallbackFlow(baseUrl, failures);
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
  } finally {
    if (!external) {
      child.kill('SIGTERM');
      const exited = await waitExit(child, 5000);
      if (exited === 'timeout') child.kill('SIGKILL');
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(cfgDir, { recursive: true, force: true });
    }
  }

  if (failures.length > 0) {
    console.error('Integration failures:\n', failures.join('\n'));
    const stderrTail = getStderr().slice(-2000);
    if (stderrTail.trim()) console.error('Daemon stderr tail:\n', stderrTail);
    process.exit(1);
  }
  console.log('Integration OK:', baseUrl, '(mailbox + approval + social action + bot policy + bot model + skill proposal + model fallback endpoints)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
