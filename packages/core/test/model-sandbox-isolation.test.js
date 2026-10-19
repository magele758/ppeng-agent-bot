import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { createToolServices } from '../dist/runtime/tool-services.js';
import { checkToolApprovals } from '../dist/runtime/tool-loop.js';
import { startBackgroundJob } from '../dist/runtime/spawn-host.js';
import { SandboxManager } from '../dist/sandbox/os-sandbox.js';
import { bindSandboxSettingsStore, SANDBOX_SETTINGS_KEY } from '../dist/sandbox/sandbox-settings.js';
import {
  CONTAINER_ISOLATION_REFUSAL,
  DIRECT_ISOLATION_REFUSAL,
  OS_UNAVAILABLE_REFUSAL,
  decideShellIsolation,
  planDirectIsolationHold,
  approvalGrantsDirectIsolation,
  shellIsolationAvailability
} from '../dist/sandbox/model-isolation.js';

const nativeAvailability = () => shellIsolationAvailability('native');

function ctx(dir) {
  return {
    repoRoot: dir,
    workspaceRoot: dir,
    stateDir: dir,
    agent: { id: 'general' },
    session: { id: 'sess-iso', metadata: { permissionMode: 'auto' } }
  };
}

function bashTool(services = {}) {
  return createBuiltinTools(services).find((tool) => tool.name === 'bash');
}

function toolNamed(name, services = {}) {
  return createBuiltinTools(services).find((tool) => tool.name === name);
}

test('shell tools offer implemented isolations and not container [AC:model-sandbox-isolation#AC-2]', () => {
  for (const name of ['bash', 'bg_run', 'work_evidence']) {
    const tool = toolNamed(name);
    const isolation = tool.inputSchema.properties.isolation;
    assert.deepEqual(isolation.enum, ['os', 'direct', 'remote']);
    assert.equal(isolation.enum.includes('container'), false);
    const text = `${tool.description}\n${isolation.description}`;
    assert.match(text, /strongest/i);
    assert.match(text, /weaker/i);
    assert.match(text, /\.ssh/);
    assert.match(text, /approve/i);
    assert.match(text, /remote/i);
    assert.equal(text.includes('RAW_AGENT_SANDBOX_MODE'), false);
  }
});

test('omitted isolation uses the strongest sandbox even if env and saved mode are direct [AC:model-sandbox-isolation#AC-1]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-omit-'));
  const prev = process.env.RAW_AGENT_SANDBOX_MODE;
  process.env.RAW_AGENT_SANDBOX_MODE = 'direct';
  bindSandboxSettingsStore({
    getDaemonControl(key) {
      return key === SANDBOX_SETTINGS_KEY ? { mode: 'direct' } : undefined;
    },
    setDaemonControl() {}
  });
  try {
    const bash = bashTool();
    const command = 'printf hi';
    assert.equal(bash.needsApproval(ctx(dir), { command }), false);
    const result = await bash.execute(ctx(dir), { command });
    assert.equal(result.ok, true, result.content);
    assert.equal(result.content, 'hi');
    const osUp = nativeAvailability().os;
    if (osUp) {
      assert.ok(
        result.metadata.sandbox_backend === 'sandbox-exec' || result.metadata.sandbox_backend === 'bwrap',
        result.metadata.sandbox_backend
      );
    } else {
      assert.equal(result.metadata.sandbox_backend, 'direct');
    }
  } finally {
    bindSandboxSettingsStore(undefined);
    if (prev === undefined) delete process.env.RAW_AGENT_SANDBOX_MODE;
    else process.env.RAW_AGENT_SANDBOX_MODE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the model can pick os or an approved direct run without a prior mode setting [AC:model-sandbox-isolation#AC-2] [AC:model-sandbox-isolation#AC-3]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-pick-'));
  const prev = process.env.RAW_AGENT_SANDBOX_MODE;
  process.env.RAW_AGENT_SANDBOX_MODE = 'direct';
  try {
    const osUp = nativeAvailability().os;
    const bash = bashTool({
      directIsolationApproved: () => true
    });
    if (osUp) {
      const osResult = await bash.execute(ctx(dir), { command: 'printf os', isolation: 'os' });
      assert.equal(osResult.ok, true, osResult.content);
      assert.ok(
        osResult.metadata.sandbox_backend === 'sandbox-exec' || osResult.metadata.sandbox_backend === 'bwrap'
      );
    } else {
      const missing = await bash.execute(ctx(dir), { command: 'printf os', isolation: 'os' });
      assert.equal(missing.ok, false);
      assert.match(missing.content, /not run/i);
      assert.equal(missing.content.includes('printf os'), false);
    }
    const direct = await bash.execute(ctx(dir), { command: 'printf direct', isolation: 'direct' });
    assert.equal(direct.ok, true, direct.content);
    assert.equal(direct.content, 'direct');
    assert.equal(direct.metadata.sandbox_backend, 'direct');
  } finally {
    if (prev === undefined) delete process.env.RAW_AGENT_SANDBOX_MODE;
    else process.env.RAW_AGENT_SANDBOX_MODE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direct isolation does not run until approval, including bypass [AC:model-sandbox-isolation#AC-3]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-direct-'));
  const marker = join(dir, 'ran.txt');
  const command = `printf ran > ${JSON.stringify(marker)}`;
  try {
    const bash = bashTool();
    const runCtx = ctx(dir);
    assert.equal(bash.needsApproval(runCtx, { command, isolation: 'direct' }), true);
    const refused = await bash.execute(runCtx, { command, isolation: 'direct' });
    assert.equal(refused.ok, false);
    assert.equal(refused.content, DIRECT_ISOLATION_REFUSAL);
    assert.equal(existsSync(marker), false);

    for (const permissionMode of ['auto', 'bypass']) {
      const approvals = [];
      const armed = [];
      const messages = [];
      const session = { id: 'sess-iso', metadata: { permissionMode } };
      const gateCtx = { ...runCtx, session };
      const deps = {
        armUnattendedApproval: (approval) => armed.push(approval),
        tools: createBuiltinTools({}),
        store: {
          appendMessage: (sessionId, role, parts) => messages.push({ sessionId, role, parts }),
          listApprovals: () => approvals,
          createApproval: (input) => {
            const row = {
              id: `appr-${approvals.length + 1}`,
              status: 'pending',
              createdAt: '2026-10-19T00:00:00.000Z',
              ...input
            };
            approvals.push(row);
            return row;
          },
          deleteApproval() {},
          getTask: () => undefined,
          updateTask() {}
        },
        envApprovalPolicy: undefined,
        maxParallelToolCalls: 1,
        modelAdapter: {},
        stateDir: dir,
        emitTrace() {}
      };
      const decision = checkToolApprovals(
        deps,
        [{ type: 'tool_call', toolCallId: 'c1', name: 'bash', input: { command, isolation: 'direct' } }],
        gateCtx,
        undefined,
        session,
        deps.tools
      );
      assert.equal(decision, 'waiting', permissionMode);
      assert.equal(approvals.length, 1, permissionMode);
      assert.deepEqual(armed, approvals, `expiry armed in ${permissionMode}`);
      assert.equal(messages.length, 0, permissionMode);
      assert.equal(existsSync(marker), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unavailable os isolation and container do not run and do not fall back to direct [AC:model-sandbox-isolation#AC-4]', async () => {
  const missingOs = decideShellIsolation('os', { kind: 'native', os: false, remote: false });
  assert.equal(missingOs.ok, false);
  assert.equal(missingOs.message, OS_UNAVAILABLE_REFUSAL);
  const container = decideShellIsolation('container', { kind: 'native', os: true, remote: true });
  assert.equal(container.ok, false);
  assert.equal(container.message, CONTAINER_ISOLATION_REFUSAL);
  const remoteMissing = decideShellIsolation('remote', { kind: 'native', os: true, remote: false });
  assert.equal(remoteMissing.ok, false);
  assert.match(remoteMissing.message, /not run/i);
  assert.equal(remoteMissing.message.toLowerCase().includes('direct'), false);

  const dir = mkdtempSync(join(tmpdir(), 'iso-refuse-'));
  const marker = join(dir, 'ran.txt');
  const command = `printf ran > ${JSON.stringify(marker)}`;
  try {
    const bash = bashTool({ directIsolationApproved: () => true });
    const refused = await bash.execute(ctx(dir), { command, isolation: 'container' });
    assert.equal(refused.ok, false);
    assert.equal(refused.content, CONTAINER_ISOLATION_REFUSAL);
    assert.equal(existsSync(marker), false);
    const manager = await new SandboxManager('direct').execute(command, dir, { mode: 'container', strict: true });
    assert.equal(manager.code, 126);
    assert.notEqual(manager.backend, 'direct');
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('environment scrubbing still applies for os and approved direct [AC:model-sandbox-isolation#AC-5]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-env-'));
  const prev = process.env.LD_PRELOAD;
  process.env.LD_PRELOAD = '/tmp/ppeng-sandbox-evil.so';
  try {
    const bash = bashTool({ directIsolationApproved: () => true });
    const choices = nativeAvailability().os ? ['os', 'direct'] : ['direct'];
    for (const isolation of choices) {
      const result = await bash.execute(ctx(dir), {
        command: 'printenv LD_PRELOAD || true',
        isolation
      });
      assert.equal(result.ok, true, `${isolation}: ${result.content}`);
      assert.equal(result.content.includes('ppeng-sandbox-evil'), false, isolation);
    }
  } finally {
    if (prev === undefined) delete process.env.LD_PRELOAD;
    else process.env.LD_PRELOAD = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bg_run and work_evidence honor the same isolation choice and direct approval [AC:model-sandbox-isolation#AC-2] [AC:model-sandbox-isolation#AC-3]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-bg-'));
  const prev = process.env.RAW_AGENT_SANDBOX_MODE;
  process.env.RAW_AGENT_SANDBOX_MODE = 'direct';
  const calls = [];
  const jobs = [];
  const host = {
    repoRoot: dir,
    stateDir: dir,
    sandbox: {
      kind: 'native',
      async execute(req) {
        calls.push(req);
        return { stdout: 'ok', stderr: '', code: 0, signal: null, kind: 'native', backend: 'sandbox-exec' };
      }
    },
    setSandbox() {},
    backgroundJobAborts: new Map(),
    store: {
      getSession: () => ({ id: 's', metadata: {} }),
      createBackgroundJob(input) {
        const job = { id: 'j1', ...input };
        jobs.push(job);
        return job;
      },
      updateBackgroundJob() {},
      appendMessage() {},
      listApprovals: () => []
    }
  };
  try {
    const osUp = nativeAvailability().os;
    await startBackgroundJob(host, 's', 'printf hi');
    assert.equal(jobs.length, 1);
    if (osUp) assert.equal(calls[0].isolation, 'os');
    else assert.equal(calls[0].isolation, 'direct');
    await assert.rejects(() => startBackgroundJob(host, 's', 'printf hi', { isolation: 'direct' }));
    assert.equal(calls.length, 1);
    assert.equal(jobs.length, 1);

    const args = { command: 'printf hi', isolation: 'direct' };
    const rows = [
      { sessionId: 's', toolName: 'bg_run', status: 'approved', args, createdAt: '2026-10-19T00:00:00.000Z' },
      { sessionId: 's', toolName: 'bg_run', status: 'rejected', args, createdAt: '2026-10-19T00:00:01.000Z' }
    ];
    host.store.listApprovals = (filter) => rows.filter((row) => !filter?.status || row.status === filter.status);
    await assert.rejects(() => startBackgroundJob(host, 's', args.command, { isolation: args.isolation }), /needs human approval/);
    assert.equal(calls.length, 1);
    assert.equal(jobs.length, 1);
    rows.pop();
    await startBackgroundJob(host, 's', args.command, { isolation: args.isolation });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].isolation, 'direct');

    let started = 0;
    const bg = toolNamed('bg_run', {
      startBackgroundJob: async (_sessionId, _command, options) => {
        started += 1;
        return { id: 'job', options };
      }
    });
    const blocked = await bg.execute(ctx(dir), { command: 'printf hi', isolation: 'direct' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.content, DIRECT_ISOLATION_REFUSAL);
    assert.equal(started, 0);
    const evidence = toolNamed('work_evidence');
    const evidenceBlocked = await evidence.execute(ctx(dir), { isolation: 'container' });
    assert.equal(evidenceBlocked.ok, false);
    assert.equal(evidenceBlocked.content, CONTAINER_ISOLATION_REFUSAL);
    assert.equal(evidenceBlocked.content.includes('git_is_repo'), false);
  } finally {
    if (prev === undefined) delete process.env.RAW_AGENT_SANDBOX_MODE;
    else process.env.RAW_AGENT_SANDBOX_MODE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved approval is what allows a direct command to run [AC:model-sandbox-isolation#AC-3]', () => {
  const args = { command: 'printf hi', isolation: 'direct' };
  const services = createToolServices({
    store: {
      listApprovals: () => [
        { sessionId: 's', toolName: 'bash', status: 'pending', args, createdAt: '2026-10-19T00:00:00.000Z' },
        { sessionId: 's', toolName: 'bash', status: 'approved', args, createdAt: '2026-10-19T00:00:01.000Z' }
      ]
    }
  });
  assert.equal(services.directIsolationApproved('s', 'bash', args), true);
  assert.equal(services.directIsolationApproved('s', 'bash', { command: 'printf other', isolation: 'direct' }), false);
  assert.equal(
    services.directIsolationApproved('s', 'bash', { command: 'printf hi', isolation: 'os' }),
    false
  );
});

test('shell isolation approval does not intercept unrelated tool inputs [AC:model-sandbox-isolation#AC-3]', () => {
  const plan = planDirectIsolationHold(
    [{ name: 'custom_database_tool', input: { isolation: 'direct' } }], [], 's',
    { kind: 'native', os: true, remote: false }
  );
  assert.deepEqual(plan, { wait: false, create: [] });
});

test('same-millisecond approvals fail closed regardless of row order [AC:model-sandbox-isolation#AC-3]', () => {
  const args = { command: 'printf hi', isolation: 'direct' };
  const row = { sessionId: 's', toolName: 'bash', args, createdAt: '2026-10-19T00:00:00.000Z' };
  for (const status of ['pending', 'rejected']) {
    const rows = [{ ...row, status: 'approved' }, { ...row, status }];
    for (const ordered of [rows, [...rows].reverse()]) {
      assert.equal(approvalGrantsDirectIsolation(ordered, 's', 'bash', args), false);
      const plan = planDirectIsolationHold([{ name: 'bash', input: args }], ordered, 's',
        { kind: 'native', os: true, remote: false });
      assert.equal(plan.wait, status === 'pending');
    }
  }
});
