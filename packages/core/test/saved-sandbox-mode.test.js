import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { startBackgroundJob } from '../dist/runtime/spawn-host.js';
import { bindSandboxSettingsStore, SANDBOX_SETTINGS_KEY } from '../dist/sandbox/sandbox-settings.js';
import {
  CONTAINER_ISOLATION_REFUSAL,
  OS_UNAVAILABLE_REFUSAL,
  REMOTE_UNAVAILABLE_REFUSAL,
  decideShellIsolation,
  planDirectIsolationHold,
  shellIsolationAvailability
} from '../dist/sandbox/model-isolation.js';
import { OS_SANDBOX_SENSITIVE_HOME_DIRS, buildSeatbeltProfile } from '../dist/sandbox/os-sandbox.js';

const nativeAvailability = () => shellIsolationAvailability('native');

function ctx(dir) {
  return {
    repoRoot: dir,
    workspaceRoot: dir,
    stateDir: dir,
    agent: { id: 'general' },
    session: { id: 'sess-saved-sandbox', metadata: { permissionMode: 'auto' } }
  };
}

function bashTool(services = {}) {
  return createBuiltinTools(services).find((tool) => tool.name === 'bash');
}

function pinSavedMode(mode) {
  const prev = process.env.RAW_AGENT_SANDBOX_MODE;
  process.env.RAW_AGENT_SANDBOX_MODE = mode === 'direct' ? 'os' : 'direct';
  bindSandboxSettingsStore({
    getDaemonControl(key) {
      return key === SANDBOX_SETTINGS_KEY ? { mode } : undefined;
    },
    setDaemonControl() {}
  });
  return () => {
    bindSandboxSettingsStore(undefined);
    if (prev === undefined) delete process.env.RAW_AGENT_SANDBOX_MODE;
    else process.env.RAW_AGENT_SANDBOX_MODE = prev;
  };
}

test('saved direct runs ssh outside the OS sandbox even if the command asks for os [AC:saved-sandbox-mode-constrains-shell#AC-1]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saved-direct-ssh-'));
  const restore = pinSavedMode('direct');
  try {
    const bash = bashTool();
    const command = 'ssh -V';
    for (const isolation of [undefined, 'os', 'direct']) {
      const args = isolation ? { command, isolation, timeout_ms: 15000 } : { command, timeout_ms: 15000 };
      assert.equal(bash.needsApproval(ctx(dir), args), false, String(isolation));
      const plan = planDirectIsolationHold(
        [{ name: 'bash', input: args }],
        [],
        'sess-saved-sandbox',
        nativeAvailability()
      );
      assert.equal(plan.wait, false, String(isolation));
      const result = await bash.execute(ctx(dir), args);
      assert.equal(result.metadata.sandbox_backend, 'direct', `${isolation}: ${result.content}`);
      assert.equal(String(result.content).includes('[os-sandbox:'), false, String(isolation));
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved OS isolation keeps ssh in the OS sandbox and says why [AC:saved-sandbox-mode-constrains-shell#AC-2]', async () => {
  const unavailable = decideShellIsolation('direct', { kind: 'native', os: false, remote: false }, 'os');
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.message, OS_UNAVAILABLE_REFUSAL);

  const dir = mkdtempSync(join(tmpdir(), 'saved-os-ssh-'));
  const marker = join(dir, 'ran.txt');
  const restore = pinSavedMode('os');
  try {
    const bash = bashTool();
    const osUp = nativeAvailability().os;
    const command = 'ssh -V';
    assert.equal(bash.needsApproval(ctx(dir), { command, isolation: 'direct' }), false);
    const result = await bash.execute(ctx(dir), { command, isolation: 'direct', timeout_ms: 15000 });
    if (osUp) {
      assert.ok(
        result.metadata.sandbox_backend === 'sandbox-exec' || result.metadata.sandbox_backend === 'bwrap',
        result.metadata.sandbox_backend
      );
      assert.equal(result.metadata.os_sandbox_reason, 'saved-os');
      assert.match(result.content, /\[os-sandbox:saved-os\]/);
      assert.match(result.content, /not switched to a direct run/i);
    } else {
      assert.equal(result.ok, false);
      assert.equal(result.content, OS_UNAVAILABLE_REFUSAL);
      const refused = await bash.execute(ctx(dir), {
        command: `printf ran > ${JSON.stringify(marker)}`,
        isolation: 'direct'
      });
      assert.equal(refused.ok, false);
      assert.equal(existsSync(marker), false);
    }
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OS sandbox still hides key folders while direct ssh is not wrapped by it [AC:saved-sandbox-mode-constrains-shell#AC-4]', async () => {
  assert.ok(OS_SANDBOX_SENSITIVE_HOME_DIRS.includes('.ssh'));
  const profile = buildSeatbeltProfile('/workspace', '/Users/test', true);
  assert.match(profile, /\(deny file-read\* \(subpath "\/Users\/test\/\.ssh"\)\)/);
  assert.match(profile, /\(deny file-write\* \(subpath "\/Users\/test\/\.ssh"\)\)/);
  assert.equal(profile.includes('(allow file-read* (subpath "/Users/test/.ssh"))'), false);

  const dir = mkdtempSync(join(tmpdir(), 'saved-direct-profile-'));
  const restore = pinSavedMode('direct');
  try {
    const result = await bashTool().execute(ctx(dir), { command: 'ssh -V', timeout_ms: 15000 });
    assert.equal(result.metadata.sandbox_backend, 'direct', result.content);
    assert.equal(String(result.content).includes('[os-sandbox:'), false);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saved container or a disconnected remote shell does not run and does not fall back [AC:saved-sandbox-mode-constrains-shell#AC-5]', async () => {
  const containerDecision = decideShellIsolation(undefined, { kind: 'native', os: true, remote: true }, 'container');
  assert.equal(containerDecision.ok, false);
  assert.equal(containerDecision.message, CONTAINER_ISOLATION_REFUSAL);
  const remoteDecision = decideShellIsolation('os', { kind: 'native', os: true, remote: false }, 'cloudflare-computer');
  assert.equal(remoteDecision.ok, false);
  assert.equal(remoteDecision.message, REMOTE_UNAVAILABLE_REFUSAL);
  assert.equal(remoteDecision.message.toLowerCase().includes('direct'), false);

  const dir = mkdtempSync(join(tmpdir(), 'saved-container-'));
  const marker = join(dir, 'ran.txt');
  const command = `printf ran > ${JSON.stringify(marker)}`;
  const restoreContainer = pinSavedMode('container');
  try {
    const refused = await bashTool().execute(ctx(dir), { command, isolation: 'os' });
    assert.equal(refused.ok, false);
    assert.equal(refused.content, CONTAINER_ISOLATION_REFUSAL);
    assert.equal(existsSync(marker), false);
  } finally {
    restoreContainer();
  }

  const prevEndpoint = process.env.CLOUDFLARE_COMPUTER_ENDPOINT;
  delete process.env.CLOUDFLARE_COMPUTER_ENDPOINT;
  const restoreRemote = pinSavedMode('cloudflare-computer');
  try {
    const refused = await bashTool().execute(ctx(dir), { command, isolation: 'direct' });
    assert.equal(refused.ok, false, refused.content);
    assert.match(refused.content, /not run/i);
    assert.equal(existsSync(marker), false);
    assert.notEqual(refused.metadata?.sandbox_backend, 'direct');
    assert.notEqual(refused.metadata?.sandbox_backend, 'sandbox-exec');
  } finally {
    restoreRemote();
    if (prevEndpoint === undefined) delete process.env.CLOUDFLARE_COMPUTER_ENDPOINT;
    else process.env.CLOUDFLARE_COMPUTER_ENDPOINT = prevEndpoint;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('background shell follows saved direct instead of a per-command os choice [AC:saved-sandbox-mode-constrains-shell#AC-1]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'saved-direct-bg-'));
  const restore = pinSavedMode('direct');
  const calls = [];
  const host = {
    repoRoot: dir,
    stateDir: dir,
    sandbox: {
      kind: 'native',
      async execute(req) {
        calls.push(req);
        return { stdout: 'ok', stderr: '', code: 0, signal: null, kind: 'native', backend: 'direct' };
      }
    },
    setSandbox() {},
    backgroundJobAborts: new Map(),
    store: {
      db: { isOpen: true },
      runWithoutWriterScope: (fn) => fn(),
      enqueueSteer() {},
      getSession: () => ({ id: 's', metadata: { permissionMode: 'auto' } }),
      createBackgroundJob(input) {
        return { id: 'j1', ...input };
      },
      updateBackgroundJob() {},
      appendMessage() {},
      listApprovals: () => []
    }
  };
  try {
    await startBackgroundJob(host, 's', 'ssh -V', { isolation: 'os' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].isolation, 'direct');
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});
