import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStateStore } from '../dist/storage.js';
import {
  createRegisteredMachinePort,
  createRegisteredMachineTools,
  createDesktopAgentHub,
  createDesktopAgentBackend,
  createCompositeRegisteredMachineBackend,
  createSshRegisteredMachineBackend,
  executeOnRegisteredMachine
} from '../dist/registered-machines/index.js';
import { createBuiltinTools } from '../dist/tools/builtin-tools.js';
import { FactoryService } from '../dist/factory/service.js';

function mockHandlers(remoteDir) {
  return {
    async shell(input) {
      if (input.command === 'fail') {
        return { ok: false, content: 'boom', exitCode: 2 };
      }
      const cwdNote = input.cwd ? ` cwd=${input.cwd}` : '';
      return { ok: true, content: `echo:${input.command}${cwdNote}`, exitCode: 0 };
    },
    async read(input) {
      const text = readFileSync(join(remoteDir, input.path), 'utf8');
      const lines = text.split('\n');
      const offset = input.offsetLine ?? 0;
      const limit = input.limit ?? lines.length;
      return { ok: true, content: lines.slice(offset, offset + limit).join('\n') };
    },
    async copy(input) {
      if (input.direction === 'to') {
        writeFileSync(join(remoteDir, input.remotePath), readFileSync(input.localPath));
        return {
          ok: true,
          content: JSON.stringify({ copied: 'to', remotePath: input.remotePath })
        };
      }
      writeFileSync(input.localPath, readFileSync(join(remoteDir, input.remotePath)));
      return {
        ok: true,
        content: JSON.stringify({ copied: 'from', localPath: input.localPath })
      };
    }
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'rm-agent-'));
  const remote = join(dir, 'remote');
  mkdirSync(remote);
  writeFileSync(join(remote, 'note.txt'), 'line1\nline2\nline3\n');
  const store = new SqliteStateStore(join(dir, 'state.db'));
  const principal = { userId: 'owner' };
  const hub = createDesktopAgentHub();
  const backend = createDesktopAgentBackend({ hub });
  const port = createRegisteredMachinePort(store, backend);
  const workspace = join(dir, 'ws');
  mkdirSync(workspace);
  const ctx = {
    session: { id: 's1', metadata: { userId: 'owner' } },
    repoRoot: workspace,
    workspaceRoot: workspace
  };
  return { dir, remote, store, principal, hub, backend, port, workspace, ctx };
}

test('desktop agent long-connect: attach -> list connected -> shell/read/copy [AC:registered-machine-desktop-agent#AC-1]', async () => {
  const f = fixture();
  const tools = Object.fromEntries(
    createRegisteredMachineTools(f.store, f.port).map((t) => [t.name, t])
  );

  f.port.register(f.principal, {
    machineId: 'desk',
    label: 'Desk',
    kind: 'desktop'
  });
  assert.equal((await f.port.listLive(f.principal))[0].connected, false);

  const lease = f.hub.attach('desk', mockHandlers(f.remote));
  const list = JSON.parse((await tools.list_machines.execute(f.ctx, {})).content);
  assert.equal(list.machines[0].connected, true);

  const shell = await f.port.shell(f.principal, 'desk', { command: 'uname -a', cwd: '/tmp' });
  assert.equal(shell.ok, true);
  assert.match(shell.content, /echo:uname -a cwd=\/tmp/);

  const read = await f.port.read(f.principal, 'desk', { path: 'note.txt', offsetLine: 1, limit: 1 });
  assert.equal(read.ok, true);
  assert.equal(read.content, 'line2');

  writeFileSync(join(f.workspace, 'up.txt'), 'payload');
  const to = await f.port.copy(f.principal, 'desk', {
    direction: 'to',
    localPath: join(f.workspace, 'up.txt'),
    remotePath: 'up.txt'
  });
  assert.equal(to.ok, true);
  assert.equal(readFileSync(join(f.remote, 'up.txt'), 'utf8'), 'payload');

  const from = await f.port.copy(f.principal, 'desk', {
    direction: 'from',
    localPath: join(f.workspace, 'down.txt'),
    remotePath: 'note.txt'
  });
  assert.equal(from.ok, true);
  assert.match(readFileSync(join(f.workspace, 'down.txt'), 'utf8'), /line1/);

  lease.detach();
  assert.equal((await f.port.listLive(f.principal))[0].connected, false);
  const after = await f.port.shell(f.principal, 'desk', { command: 'hi' });
  assert.equal(after.ok, false);
  assert.match(after.content, /machine_disconnected/);
});

test('desktop agent: detach and refuse sensitive paths [AC:registered-machine-desktop-agent#AC-2]', async () => {
  const f = fixture();
  f.port.register(f.principal, { machineId: 'desk', label: 'Desk', kind: 'desktop' });
  f.hub.attach('desk', mockHandlers(f.remote));

  const secret = await f.port.read(f.principal, 'desk', { path: '.ssh/id_rsa' });
  assert.equal(secret.ok, false);
  assert.match(secret.content, /refused_path|SENSITIVE|secret|refus/i);

  f.hub.detach('desk');
  assert.equal(f.hub.isAttached('desk'), false);
  const shell = await f.port.shell(f.principal, 'desk', { command: 'x' });
  assert.equal(shell.ok, false);
  assert.match(shell.content, /machine_disconnected/);
});

test('composite backend prefers agent over SSH and never touches Factory [AC:registered-machine-desktop-agent#AC-3]', async () => {
  const f = fixture();
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
  const { chmodSync } = await import('node:fs');
  chmodSync(sshBin, 0o755);

  const hub = createDesktopAgentHub();
  const backend = createCompositeRegisteredMachineBackend({
    agentHub: hub,
    ssh: { sshBin }
  });
  const port = createRegisteredMachinePort(f.store, backend);
  port.register(f.principal, {
    machineId: 'desk',
    label: 'Desk',
    kind: 'desktop',
    sshAlias: 'desk-host'
  });

  writeFileSync(sshLog, '');
  hub.attach('desk', mockHandlers(f.remote));
  const shell = await port.shell(f.principal, 'desk', { command: 'via-agent' });
  assert.equal(shell.ok, true);
  assert.match(shell.content, /echo:via-agent/);
  assert.equal(
    readFileSync(sshLog, 'utf8').includes('SSH_CALLED'),
    false,
    'SSH must not run while desktop agent is attached'
  );

  hub.detach('desk');
  const offline = await port.shell(f.principal, 'desk', { command: 'via-ssh' });
  assert.equal(offline.ok, false);
  assert.match(offline.content, /machine_disconnected/);
  assert.match(readFileSync(sshLog, 'utf8'), /SSH_CALLED/);

  const rooms = {
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
  const factory = new FactoryService({ store: f.store, rooms });
  assert.deepEqual(factory.settings(f.principal).machines, []);
});

test('bash/read_file machineId routes through desktop agent backend', async () => {
  const f = fixture();
  const port = createRegisteredMachinePort(
    f.store,
    createDesktopAgentBackend({ hub: f.hub })
  );
  port.register(f.principal, { machineId: 'phone', label: 'Phone', kind: 'phone' });
  f.hub.attach('phone', mockHandlers(f.remote));

  const shell = await executeOnRegisteredMachine(
    f.store,
    port,
    f.ctx.session,
    'phone',
    'shell',
    { command: 'pwd' }
  );
  assert.equal(shell.ok, true);
  assert.match(shell.content, /echo:pwd/);

  const builtins = Object.fromEntries(
    createBuiltinTools({ stateStore: f.store, registeredMachines: port }).map((t) => [t.name, t])
  );
  const read = await builtins.read_file.execute(f.ctx, {
    path: 'note.txt',
    machineId: 'phone'
  });
  assert.equal(read.ok, true);
  assert.match(read.content, /line1/);
});

test('createDesktopAgentBackend alone stays disconnected without attach', async () => {
  const f = fixture();
  f.port.register(f.principal, { machineId: 'x', label: 'X', kind: 'other' });
  assert.equal(f.backend.isConnected('x'), false);
  assert.equal(await f.backend.probe({ machineId: 'x', label: 'X', kind: 'other', connected: false }), false);
});
