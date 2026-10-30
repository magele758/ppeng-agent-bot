import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStateStore } from '../dist/storage.js';
import {
  createRegisteredMachinePort,
  createRegisteredMachineTools,
  createDesktopAgentHub,
  createDeviceLocalHub,
  createDeviceLocalBackend,
  createCompositeRegisteredMachineBackend,
  executeOnRegisteredMachine
} from '../dist/registered-machines/index.js';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { FactoryService } from '../dist/factory/service.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rm-phone-'));
  const remote = join(dir, 'remote');
  mkdirSync(remote);
  writeFileSync(join(remote, 'note.txt'), 'line1\nline2\nline3\n');
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const principal = { userId: 'owner' };
  const hub = createDeviceLocalHub();
  const desktop = createDesktopAgentHub();
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  const ctx = {
    session: { id: 's1', metadata: { userId: 'owner' } },
    repoRoot: workspace,
    workspaceRoot: workspace
  };
  return { dir, remote, store, principal, hub, desktop, workspace, ctx };
}

function readHandlers(remote, calls) {
  return {
    async read(input) {
      calls.push({ op: 'read', path: input.path });
      const text = readFileSync(join(remote, input.path), 'utf8');
      const lines = text.split('\n');
      const offset = input.offsetLine ?? 0;
      const limit = input.limit ?? lines.length;
      return { ok: true, content: lines.slice(offset, offset + limit).join('\n') };
    },
    async shell(input) {
      calls.push({ op: 'shell', command: input.command });
      return { ok: true, content: `echo:${input.command}`, exitCode: 0 };
    },
    async copy(input) {
      calls.push({ op: 'copy', direction: input.direction });
      return { ok: true, content: JSON.stringify({ copied: input.direction }) };
    }
  };
}

function rooms() {
  return {
    create() {
      return { id: 'room-1', botIds: ['bot'] };
    },
    get() {
      return { id: 'room-1', botIds: ['bot'] };
    },
    addMember() {},
    turns() {
      return [];
    }
  };
}

test('phone kind lists deviceLocalTools and read uses device-local hub, not ssh [AC:registered-machine-phone-local#AC-1]', async () => {
  const f = fixture();
  const calls = [];
  const backend = createDeviceLocalBackend({ hub: f.hub });
  const port = createRegisteredMachinePort(f.store, backend);
  const tools = Object.fromEntries(
    createRegisteredMachineTools(f.store, port).map((t) => [t.name, t])
  );

  port.register(f.principal, {
    machineId: 'pixel',
    label: 'Pixel',
    kind: 'phone',
    deviceLocalTools: [{ toolId: 'device_get_location', state: 'needs_permission' }]
  });
  assert.equal((await port.listLive(f.principal))[0].connected, false);

  f.hub.attach('pixel', readHandlers(f.remote, calls));
  const list = JSON.parse((await tools.list_machines.execute(f.ctx, {})).content);
  assert.equal(list.machines[0].kind, 'phone');
  assert.equal(list.machines[0].connected, true);
  assert.equal(list.machines[0].deviceLocalTools[0].toolId, 'device_get_location');
  assert.equal(list.machines[0].deviceLocalTools[0].state, 'needs_permission');

  const read = await port.read(f.principal, 'pixel', { path: 'note.txt', offsetLine: 1, limit: 1 });
  assert.equal(read.ok, true);
  assert.equal(read.content, 'line2');
  assert.deepEqual(calls, [{ op: 'read', path: 'note.txt' }]);

  const builtins = Object.fromEntries(
    createBuiltinTools({ stateStore: f.store, registeredMachines: port }).map((t) => [t.name, t])
  );
  calls.length = 0;
  const viaTool = await builtins.read_file.execute(f.ctx, { path: 'note.txt', machineId: 'pixel' });
  assert.equal(viaTool.ok, true);
  assert.match(viaTool.content, /line1/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].op, 'read');
});

test('phone default slice refuses shell/copy and sensitive paths; detach fails closed [AC:registered-machine-phone-local#AC-2]', async () => {
  const f = fixture();
  const calls = [];
  const port = createRegisteredMachinePort(f.store, createDeviceLocalBackend({ hub: f.hub }));
  port.register(f.principal, {
    machineId: 'pixel',
    label: 'Pixel',
    kind: 'phone',
    deviceLocalTools: [
      { toolId: 'device_shell', state: 'available' },
      { toolId: 'device_copy', state: 'available' }
    ]
  });
  const lease = f.hub.attach('pixel', readHandlers(f.remote, calls));

  const shell = await port.shell(f.principal, 'pixel', { command: 'id' });
  assert.equal(shell.ok, false);
  assert.match(shell.content, /device_local_readonly/);

  const copy = await port.copy(f.principal, 'pixel', {
    direction: 'from',
    localPath: join(f.workspace, 'down.txt'),
    remotePath: 'note.txt'
  });
  assert.equal(copy.ok, false);
  assert.match(copy.content, /device_local_readonly/);
  assert.deepEqual(calls, []);

  const secret = await port.read(f.principal, 'pixel', { path: '.ssh/id_rsa' });
  assert.equal(secret.ok, false);
  assert.match(secret.content, /refused_path|SENSITIVE|secret|refus/i);
  assert.deepEqual(calls, []);

  lease.detach();
  assert.equal((await port.listLive(f.principal))[0].connected, false);
  const after = await port.read(f.principal, 'pixel', { path: 'note.txt' });
  assert.equal(after.ok, false);
  assert.match(after.content, /machine_disconnected/);
});

test('composite prefers phone device-local over SSH and never touches Factory [AC:registered-machine-phone-local#AC-3]', async () => {
  const f = fixture();
  const calls = [];
  const sshLog = join(f.dir, 'ssh.log');
  const sshBin = join(f.dir, 'ssh');
  writeFileSync(
    sshBin,
    `#!/bin/sh
printf 'SSH_CALLED\\n' >> "${sshLog}"
echo "ssh: Connection refused" >&2
exit 255
`
  );
  chmodSync(sshBin, 0o755);
  writeFileSync(sshLog, '');

  let desktopCalls = 0;
  const backend = createCompositeRegisteredMachineBackend({
    agentHub: f.desktop,
    deviceLocalHub: f.hub,
    ssh: { sshBin }
  });
  const port = createRegisteredMachinePort(f.store, backend);
  port.register(f.principal, {
    machineId: 'pixel',
    label: 'Pixel',
    kind: 'phone',
    sshAlias: 'phone-host',
    deviceLocalTools: [{ toolId: 'device_get_location', state: 'unavailable' }]
  });

  f.desktop.attach('pixel', {
    async shell() {
      desktopCalls += 1;
      return { ok: true, content: 'desktop-hub' };
    },
    async read() {
      desktopCalls += 1;
      return { ok: true, content: 'desktop-hub' };
    },
    async copy() {
      desktopCalls += 1;
      return { ok: true, content: 'desktop-hub' };
    }
  });
  f.hub.attach('pixel', readHandlers(f.remote, calls));

  const read = await port.read(f.principal, 'pixel', { path: 'note.txt' });
  assert.equal(read.ok, true);
  assert.match(read.content, /line1/);
  assert.equal(calls.length, 1);
  assert.equal(desktopCalls, 0);
  assert.equal(readFileSync(sshLog, 'utf8').includes('SSH_CALLED'), false);

  f.hub.detach('pixel');
  f.desktop.detach('pixel');
  const offline = await port.read(f.principal, 'pixel', { path: 'note.txt' });
  assert.equal(offline.ok, false);
  assert.match(offline.content, /machine_disconnected/);
  assert.match(readFileSync(sshLog, 'utf8'), /SSH_CALLED/);
  assert.equal(desktopCalls, 0);

  const factory = new FactoryService({ store: f.store, rooms: rooms() });
  assert.deepEqual(factory.settings(f.principal).machines, []);
});

test('opt-in shell still requires device_shell available and does not spawn ssh [AC:registered-machine-phone-local#AC-4]', async () => {
  const f = fixture();
  const calls = [];
  const sshLog = join(f.dir, 'ssh.log');
  const sshBin = join(f.dir, 'ssh');
  writeFileSync(
    sshBin,
    `#!/bin/sh
printf 'SSH_CALLED\\n' >> "${sshLog}"
exit 255
`
  );
  chmodSync(sshBin, 0o755);
  writeFileSync(sshLog, '');

  const backend = createCompositeRegisteredMachineBackend({
    agentHub: f.desktop,
    deviceLocalHub: f.hub,
    ssh: { sshBin }
  });
  const port = createRegisteredMachinePort(f.store, backend);
  port.register(f.principal, {
    machineId: 'pixel',
    label: 'Pixel',
    kind: 'phone',
    sshAlias: 'phone-host',
    deviceLocalTools: [{ toolId: 'device_shell', state: 'needs_permission' }]
  });
  f.hub.attach('pixel', readHandlers(f.remote, calls), { shell: true });

  const blocked = await executeOnRegisteredMachine(
    f.store,
    port,
    f.ctx.session,
    'pixel',
    'shell',
    { command: 'pwd' }
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.content, /device_local_tool_unavailable/);
  assert.deepEqual(calls, []);
  assert.equal(readFileSync(sshLog, 'utf8').includes('SSH_CALLED'), false);

  port.register(f.principal, {
    machineId: 'pixel',
    label: 'Pixel',
    kind: 'phone',
    sshAlias: 'phone-host',
    deviceLocalTools: [{ toolId: 'device_shell', state: 'available' }]
  });
  const shell = await port.shell(f.principal, 'pixel', { command: 'pwd' });
  assert.equal(shell.ok, true);
  assert.match(shell.content, /echo:pwd/);
  assert.equal(calls.filter((row) => row.op === 'shell').length, 1);
  assert.equal(readFileSync(sshLog, 'utf8').includes('SSH_CALLED'), false);
});
