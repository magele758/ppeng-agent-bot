import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStateStore } from '../dist/storage.js';
import { botPrincipalKey } from '../dist/bots/bot-identity.js';
import {
  createRegisteredMachinePort,
  createDisconnectedBackend,
  createRegisteredMachineTools,
  executeOnRegisteredMachine
} from '../dist/registered-machines/index.js';
import { FactoryService } from '../dist/factory/service.js';
import { filterFactoryTools } from '../dist/factory/tool-policy.js';

function fixture(backend) {
  const path = join(mkdtempSync(join(tmpdir(), 'registered-machines-')), 'state.db');
  const store = new SqliteStateStore(path);
  const principal = { userId: 'owner' };
  const port = createRegisteredMachinePort(store, backend ?? createDisconnectedBackend());
  return { store, principal, port };
}

test('RegisteredMachinePort register/list/unregister uses registered.machines key only', () => {
  const f = fixture();
  assert.deepEqual(f.port.list(f.principal), []);
  const mac = f.port.register(f.principal, {
    machineId: 'mac-1',
    label: 'MacBook',
    kind: 'desktop'
  });
  assert.equal(mac.machineId, 'mac-1');
  assert.equal(mac.connected, false);
  assert.equal(f.port.list(f.principal).length, 1);

  const key = 'registered.machines:' + botPrincipalKey(f.principal);
  assert.ok(f.store.getDaemonControl(key));
  assert.equal(
    f.store.getDaemonControl('factory.settings:' + botPrincipalKey(f.principal)),
    undefined
  );

  assert.equal(f.port.unregister(f.principal, 'mac-1'), true);
  assert.deepEqual(f.port.list(f.principal), []);
});

test('RegisteredMachinePort does not read or write Factory settings rail', () => {
  const f = fixture();
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
  const before = factory.settings(f.principal);
  assert.deepEqual(before.machines, []);

  f.port.register(f.principal, {
    machineId: 'phone-1',
    label: 'Phone',
    kind: 'phone',
    deviceLocalTools: [{ toolId: 'device_get_location', state: 'needs_permission' }]
  });

  const after = factory.settings(f.principal);
  assert.deepEqual(after.machines, []);
  assert.equal(after.roomId, before.roomId);
  assert.equal(after.coordinatorBotId, before.coordinatorBotId);

  const listed = f.port.list(f.principal);
  assert.equal(listed[0].kind, 'phone');
  assert.equal(listed[0].deviceLocalTools?.[0].toolId, 'device_get_location');
});

test('machineId-gated shell/read require registered id and use backend not Factory', async () => {
  const calls = [];
  const backend = {
    isConnected(id) {
      return id === 'desk-1';
    },
    async shell(machine, input) {
      calls.push({ op: 'shell', machineId: machine.machineId, command: input.command });
      return { ok: true, content: 'remote-shell-ok', exitCode: 0 };
    },
    async read(machine, input) {
      calls.push({ op: 'read', machineId: machine.machineId, path: input.path });
      return { ok: true, content: 'remote-file' };
    },
    async copy(machine, input) {
      calls.push({ op: 'copy', machineId: machine.machineId, ...input });
      return { ok: true, content: 'copied' };
    }
  };
  const f = fixture(backend);
  f.port.register(f.principal, { machineId: 'desk-1', label: 'Desk', kind: 'desktop' });

  const session = { metadata: { userId: 'owner' } };
  const local = await executeOnRegisteredMachine(f.store, f.port, session, undefined, 'shell', {
    command: 'echo hi'
  });
  assert.equal(local, null);

  const missing = await executeOnRegisteredMachine(f.store, f.port, session, 'nope', 'shell', {
    command: 'echo hi'
  });
  assert.equal(missing.ok, false);
  assert.match(missing.content, /unknown_machine|NotFound|RegisteredMachine/i);

  const remote = await executeOnRegisteredMachine(f.store, f.port, session, 'desk-1', 'shell', {
    command: 'uname -a'
  });
  assert.equal(remote.ok, true);
  assert.equal(remote.content, 'remote-shell-ok');

  const read = await executeOnRegisteredMachine(f.store, f.port, session, 'desk-1', 'read', {
    path: '/tmp/x'
  });
  assert.equal(read.ok, true);
  assert.equal(read.content, 'remote-file');

  const copy = await f.port.copy(f.principal, 'desk-1', {
    direction: 'to',
    localPath: 'a.txt',
    remotePath: '/tmp/a.txt'
  });
  assert.equal(copy.ok, true);
  assert.deepEqual(
    calls.map((c) => c.op),
    ['shell', 'read', 'copy']
  );
});

test('list_machines tool returns registered machines only; factory filter untouched', async () => {
  const f = fixture({
    isConnected: () => true,
    async shell() {
      return { ok: true, content: '' };
    },
    async read() {
      return { ok: true, content: '' };
    },
    async copy() {
      return { ok: true, content: '' };
    }
  });
  f.port.register(f.principal, { machineId: 'm1', label: 'One', kind: 'desktop' });
  const tools = createRegisteredMachineTools(f.store, f.port);
  const list = tools.find((t) => t.name === 'list_machines');
  assert.ok(list);
  const result = await list.execute(
    { session: { id: 's1', metadata: { userId: 'owner' } } },
    {}
  );
  assert.equal(result.ok, true);
  const body = JSON.parse(result.content);
  assert.equal(body.machines[0].machineId, 'm1');
  assert.equal(body.machines[0].connected, true);

  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'copy_from_machine',
    'copy_to_machine',
    'list_machines',
    'register_machine',
    'unregister_machine'
  ]);
  for (const name of names) {
    assert.equal(name.startsWith('factory_'), false);
  }

  const factoryish = [
    { name: 'bash' },
    { name: 'factory_status' },
    { name: 'factory_dispatch' },
    { name: 'list_machines' }
  ];
  const filtered = filterFactoryTools({ metadata: {} }, factoryish);
  assert.deepEqual(
    filtered.map((t) => t.name),
    factoryish.map((t) => t.name)
  );
});

test('unregister_machine tool removes machine and returns not_found for unknown id', async () => {
  const f = fixture({
    isConnected: () => true,
    async shell() {
      return { ok: true, content: '' };
    },
    async read() {
      return { ok: true, content: '' };
    },
    async copy() {
      return { ok: true, content: '' };
    }
  });
  f.port.register(f.principal, { machineId: 'm1', label: 'One', kind: 'desktop' });
  f.port.register(f.principal, { machineId: 'm2', label: 'Two', kind: 'phone' });
  assert.equal(f.port.list(f.principal).length, 2);

  const tools = createRegisteredMachineTools(f.store, f.port);
  const unregister = tools.find((t) => t.name === 'unregister_machine');
  assert.ok(unregister);

  // Verify tool properties
  assert.equal(unregister.approvalMode, 'auto');
  assert.equal(unregister.sideEffectLevel, 'none');
  assert.equal(unregister.needsApproval(), true);

  // Unregister existing machine
  const result1 = await unregister.execute(
    { session: { id: 's1', metadata: { userId: 'owner' } } },
    { machineId: 'm1' }
  );
  assert.equal(result1.ok, true);
  const body1 = JSON.parse(result1.content);
  assert.equal(body1.ok, true);
  assert.equal(body1.id, 'm1');
  assert.equal(f.port.list(f.principal).length, 1);
  assert.equal(f.port.list(f.principal)[0].machineId, 'm2');

  // Unregister unknown machine
  const result2 = await unregister.execute(
    { session: { id: 's1', metadata: { userId: 'owner' } } },
    { machineId: 'unknown' }
  );
  assert.equal(result2.ok, false);
  const body2 = JSON.parse(result2.content);
  assert.equal(body2.error, 'machine_not_found');
  assert.equal(body2.id, 'unknown');
  assert.equal(f.port.list(f.principal).length, 1);
});

test('tool list includes unregister_machine after register_machine', async () => {
  const f = fixture();
  const tools = createRegisteredMachineTools(f.store, f.port);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'copy_from_machine',
    'copy_to_machine',
    'list_machines',
    'register_machine',
    'unregister_machine'
  ]);
});
