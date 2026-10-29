import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStateStore } from '../dist/storage.js';
import {
  createRegisteredMachinePort,
  createRegisteredMachineTools,
  createSshRegisteredMachineBackend
} from '../dist/registered-machines/index.js';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { createToolServices } from '../dist/runtime/tool-services.js';
import { FactoryService } from '../dist/factory/service.js';

/**
 * `ssh` stand-in: logs argv, simulates connection failure for alias "offline",
 * otherwise runs the remote command string through `sh -c` locally (what sshd does).
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rm-ssh-'));
  const log = join(dir, 'ssh.log');
  const bin = join(dir, 'ssh');
  writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" | tr '\\n' ' ' >> "${log}"; echo >> "${log}"
while [ "$1" != "--" ]; do shift; done
shift
alias=$1; shift
if [ "$alias" = "offline" ]; then
  echo "ssh: connect to host offline port 22: Connection refused" >&2
  exit 255
fi
exec sh -c "$1"
`
  );
  chmodSync(bin, 0o755);
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const principal = { userId: 'owner' };
  const backend = createSshRegisteredMachineBackend({ sshBin: bin });
  const port = createRegisteredMachinePort(store, backend);
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  const remote = join(dir, 'remote');
  mkdirSync(remote);
  const ctx = {
    session: { id: 's1', metadata: { userId: 'owner' } },
    repoRoot: workspace,
    workspaceRoot: workspace
  };
  const sshCalls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { dir, store, principal, port, ctx, workspace, remote, sshCalls };
}

function builtin(f) {
  return createBuiltinTools({
    stateStore: f.store,
    registeredMachines: f.port
  });
}

test('live SSH backend: register -> list -> shell/read/copy on a reachable host [AC:registered-machine-live-backend#AC-1]', async () => {
  const f = fixture();
  const tools = Object.fromEntries(
    [...createRegisteredMachineTools(f.store, f.port), ...builtin(f)].map((t) => [t.name, t])
  );

  const reg = await tools.register_machine.execute(f.ctx, {
    machineId: 'desk',
    label: 'Desk',
    kind: 'desktop',
    sshAlias: 'desk-host'
  });
  assert.equal(reg.ok, true, reg.content);
  assert.equal(JSON.parse(reg.content).machine.connected, true);

  const list = JSON.parse((await tools.list_machines.execute(f.ctx, {})).content);
  assert.equal(list.machines[0].machineId, 'desk');
  assert.equal(list.machines[0].connected, true);
  assert.equal(list.machines[0].sshAlias, 'desk-host');

  const shell = await tools.bash.execute(f.ctx, {
    command: `cd ${f.remote} && echo hello-remote && echo warn >&2`,
    machineId: 'desk'
  });
  assert.equal(shell.ok, true, shell.content);
  assert.match(shell.content, /hello-remote/);
  assert.match(shell.content, /\[stderr\]\nwarn/);

  const cwdRun = await f.port.shell(f.principal, 'desk', { command: 'pwd', cwd: f.remote });
  assert.equal(cwdRun.content, f.remote);
  const slow = await f.port.shell(f.principal, 'desk', { command: 'sleep 5', timeoutMs: 1000 });
  assert.equal(slow.ok, false);
  assert.match(slow.content, /\[timed out\]/);

  const failing = await tools.bash.execute(f.ctx, { command: 'exit 7', machineId: 'desk' });
  assert.equal(failing.ok, false);
  assert.match(failing.content, /exit_code: 7/);

  const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') + '\n';
  writeFileSync(join(f.remote, 'notes.txt'), lines);
  const read = await tools.read_file.execute(f.ctx, {
    machineId: 'desk',
    path: join(f.remote, 'notes.txt'),
    offset_line: 2,
    limit: 3
  });
  assert.equal(read.ok, true, read.content);
  assert.match(read.content, /^lines 2-4 \(more below\)\nline2\nline3\nline4$/);

  const dirRead = await tools.read_file.execute(f.ctx, { machineId: 'desk', path: f.remote });
  assert.match(dirRead.content, /notes\.txt/);

  writeFileSync(join(f.workspace, 'up.bin'), Buffer.from([0, 1, 2, 255, 10, 39]));
  const up = await tools.copy_to_machine.execute(f.ctx, {
    machineId: 'desk',
    localPath: 'up.bin',
    remotePath: join(f.remote, 'up.bin')
  });
  assert.equal(up.ok, true, up.content);
  assert.deepEqual(readFileSync(join(f.remote, 'up.bin')), Buffer.from([0, 1, 2, 255, 10, 39]));

  const down = await tools.copy_from_machine.execute(f.ctx, {
    machineId: 'desk',
    remotePath: join(f.remote, 'notes.txt'),
    localPath: 'sub/down.txt'
  });
  assert.equal(down.ok, true, down.content);
  assert.equal(readFileSync(join(f.workspace, 'sub', 'down.txt'), 'utf8'), lines);

  const escape = await tools.copy_from_machine.execute(f.ctx, {
    machineId: 'desk',
    remotePath: join(f.remote, 'notes.txt'),
    localPath: '../escape.txt'
  });
  assert.equal(escape.ok, false);
  assert.equal(existsSync(join(f.dir, 'escape.txt')), false);

  const calls = f.sshCalls();
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(call, /BatchMode=yes/);
    assert.match(call, /StrictHostKeyChecking=yes/);
    assert.match(call, /ClearAllForwardings=yes/);
    assert.match(call, /-- desk-host /);
  }
});

test('live SSH backend fails closed: offline, no alias, unregistered [AC:registered-machine-live-backend#AC-2]', async () => {
  const f = fixture();
  const marker = join(f.remote, 'ran');
  f.port.register(f.principal, { machineId: 'down', label: 'Down', kind: 'desktop', sshAlias: 'offline' });
  f.port.register(f.principal, { machineId: 'phone', label: 'Phone', kind: 'phone' });

  const live = await f.port.listLive(f.principal);
  assert.deepEqual(
    live.map((m) => [m.machineId, m.connected]),
    [
      ['down', false],
      ['phone', false]
    ]
  );

  const session = f.ctx.session;
  const { executeOnRegisteredMachine } = await import('../dist/registered-machines/index.js');
  for (const id of ['down', 'phone']) {
    const shell = await executeOnRegisteredMachine(f.store, f.port, session, id, 'shell', {
      command: `touch ${marker}`
    });
    assert.equal(shell.ok, false);
    assert.match(shell.content, /machine_disconnected/);
    const read = await executeOnRegisteredMachine(f.store, f.port, session, id, 'read', { path: marker });
    assert.match(read.content, /machine_disconnected/);
    const copy = await f.port.copy(f.principal, id, {
      direction: 'to',
      localPath: join(f.workspace, 'x'),
      remotePath: marker
    });
    assert.match(copy.content, /machine_disconnected/);
  }
  assert.equal(existsSync(marker), false);
  assert.ok(f.sshCalls().every((c) => c.includes('-- offline ')), 'only probes of the offline alias hit ssh');

  const unknown = await executeOnRegisteredMachine(f.store, f.port, session, 'ghost', 'shell', { command: 'id' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.content, /unknown_machine/);

  assert.throws(
    () => f.port.register(f.principal, { machineId: 'bad', label: 'Bad', kind: 'other', sshAlias: '-oProxyCommand=x' }),
    /Invalid sshAlias/
  );
});

test('registered machines never touch Factory settings or transport [AC:registered-machine-live-backend#AC-3]', async () => {
  const f = fixture();
  const rooms = { create: () => ({ id: 'r', botIds: ['bot'] }), get: () => ({ id: 'r', botIds: ['bot'] }), addMember() {}, turns: () => [] };
  const factory = new FactoryService({ store: f.store, rooms });
  const before = JSON.stringify(factory.settings(f.principal));

  f.port.register(f.principal, { machineId: 'desk', label: 'Desk', kind: 'desktop', sshAlias: 'desk-host' });
  await f.port.shell(f.principal, 'desk', { command: 'echo ok' });
  writeFileSync(join(f.workspace, 'a.txt'), 'a');
  await f.port.copy(f.principal, 'desk', {
    direction: 'to',
    localPath: join(f.workspace, 'a.txt'),
    remotePath: join(f.remote, 'a.txt')
  });

  assert.equal(JSON.stringify(factory.settings(f.principal)), before);
  assert.equal(f.store.getDaemonControl('factory.settings:user:owner'), undefined);
  const source = readFileSync(new URL('../dist/registered-machines/ssh-backend.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from '[^']*factory[^']*'/i);
  assert.doesNotMatch(source, /factory\.settings|getDaemonControl/);
  const services = createToolServices({ store: f.store });
  assert.ok(services.registeredMachines, 'runtime wires the live SSH-backed port');
});

test('remote ops need approval; hardline, secret paths and escapes are refused before ssh [AC:registered-machine-live-backend#AC-4]', async () => {
  const f = fixture();
  f.port.register(f.principal, { machineId: 'desk', label: 'Desk', kind: 'desktop', sshAlias: 'desk-host' });
  const tools = Object.fromEntries(
    [...createRegisteredMachineTools(f.store, f.port), ...builtin(f)].map((t) => [t.name, t])
  );
  const ctx = f.ctx;

  assert.equal(tools.bash.needsApproval(ctx, { command: 'ls', machineId: 'desk' }), true);
  assert.equal(tools.read_file.needsApproval(ctx, { path: 'x', machineId: 'desk' }), true);
  assert.equal(tools.read_file.needsApproval(ctx, { path: 'x' }), false);
  assert.equal(tools.copy_to_machine.needsApproval(ctx, {}), true);
  assert.equal(tools.copy_from_machine.needsApproval(ctx, {}), true);
  assert.equal(tools.register_machine.needsApproval(ctx, { sshAlias: 'h' }), true);
  assert.equal(tools.register_machine.needsApproval(ctx, {}), false);

  const hardline = await tools.bash.execute(ctx, { command: 'rm -rf /', machineId: 'desk' });
  assert.equal(hardline.ok, false);
  assert.match(hardline.content, /hardline/i);

  for (const path of ['/home/u/.ssh/id_ed25519', '/home/u/proj/.env', '/home/u/x/../.ssh/authorized_keys']) {
    const read = await tools.read_file.execute(ctx, { machineId: 'desk', path });
    assert.equal(read.ok, false, path);
    assert.match(read.content, /refused_path/);
  }
  const write = await tools.copy_to_machine.execute(ctx, {
    machineId: 'desk',
    localPath: 'a.txt',
    remotePath: '/home/u/.ssh/authorized_keys'
  });
  assert.match(write.content, /refused_path/);
  const key = await tools.copy_to_machine.execute(ctx, {
    machineId: 'desk',
    localPath: '.env',
    remotePath: '/tmp/x'
  });
  assert.equal(key.ok, false);

  assert.deepEqual(f.sshCalls().filter((c) => !c.includes('exit 0')), []);
});
