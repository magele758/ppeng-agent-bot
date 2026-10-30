import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStateStore } from '../dist/storage.js';
import {
  createDesktopAgentHub,
  createDesktopAgentHttpSseSession,
  createCompositeRegisteredMachineBackend,
  createRegisteredMachinePort
} from '../dist/registered-machines/index.js';
import { FactoryService } from '../dist/factory/service.js';

function eventsSink() {
  const events = [];
  return {
    events,
    send(event, data) {
      events.push({ event, data });
    }
  };
}

function machine(id = 'desk') {
  return { machineId: id, label: 'Desk', kind: 'desktop', connected: true };
}

test('HTTP/SSE session attaches and completes shell/read/copy from replies [AC:registered-machine-desktop-agent#AC-4]', async () => {
  const hub = createDesktopAgentHub();
  const sink = eventsSink();
  let n = 0;
  const session = createDesktopAgentHttpSseSession({
    hub,
    machineId: ' desk ',
    send: sink.send,
    newRequestId: () => `req-${++n}`
  });

  assert.equal(hub.isAttached('desk'), true);
  assert.equal(session.machineId, 'desk');

  const backend = createCompositeRegisteredMachineBackend({
    agentHub: hub,
    sshBackend: {
      isConnected() {
        throw new Error('ssh backend must not be consulted while agent SSE is attached');
      },
      async shell() {
        throw new Error('ssh shell');
      },
      async read() {
        throw new Error('ssh read');
      },
      async copy() {
        throw new Error('ssh copy');
      }
    }
  });

  const shellP = backend.shell(machine(), { command: 'uname -a', cwd: '/tmp' });
  const readP = backend.read(machine(), { path: 'note.txt', offsetLine: 1, limit: 1 });
  const copyP = backend.copy(machine(), {
    direction: 'to',
    localPath: '/ws/up.txt',
    remotePath: 'up.txt'
  });

  await Promise.resolve();
  assert.deepEqual(
    sink.events.map((e) => e.data.kind),
    ['shell', 'read', 'copy']
  );
  assert.equal(sink.events[0].event, 'op');
  assert.deepEqual(sink.events[0].data.input, { command: 'uname -a', cwd: '/tmp' });
  assert.equal(sink.events[1].data.input.path, 'note.txt');
  assert.equal(sink.events[2].data.input.remotePath, 'up.txt');

  assert.equal(session.handleReply({ requestId: 'nope', result: { ok: true, content: 'x' } }), false);

  assert.equal(
    session.handleReply({ requestId: 'req-1', result: { ok: true, content: 'linux', exitCode: 0 } }),
    true
  );
  assert.equal(
    session.handleReply({ requestId: 'req-2', result: { ok: true, content: 'line2' } }),
    true
  );
  assert.equal(
    session.handleReply({
      requestId: 'req-3',
      result: { ok: true, content: JSON.stringify({ copied: 'to' }) }
    }),
    true
  );

  const shell = await shellP;
  const read = await readP;
  const copy = await copyP;
  assert.equal(shell.ok, true);
  assert.equal(shell.content, 'linux');
  assert.equal(shell.exitCode, 0);
  assert.equal(read.content, 'line2');
  assert.match(copy.content, /copied/);

  assert.equal(session.handleReply({ requestId: 'req-1', result: { ok: true, content: 'again' } }), false);
});

test('closing the HTTP/SSE session detaches and fails an in-flight op [AC:registered-machine-desktop-agent#AC-4]', async () => {
  const hub = createDesktopAgentHub();
  const sink = eventsSink();
  const session = createDesktopAgentHttpSseSession({
    hub,
    machineId: 'desk',
    send: sink.send,
    newRequestId: () => 'pending-1'
  });
  const backend = createCompositeRegisteredMachineBackend({ agentHub: hub });
  const pending = backend.shell(machine(), { command: 'sleep' });
  await Promise.resolve();
  assert.equal(sink.events.length, 1);

  session.close();
  assert.equal(session.closed, true);
  assert.equal(hub.isAttached('desk'), false);

  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.content, /machine_disconnected/);

  session.close();
  assert.equal(session.handleReply({ requestId: 'pending-1', result: { ok: true, content: 'late' } }), false);
  const after = await backend.shell(machine(), { command: 'later' });
  assert.equal(after.ok, false);
  assert.match(after.content, /machine_disconnected/);
  assert.equal(sink.events.filter((e) => e.data.kind === 'shell').length, 1);
});

test('a new HTTP/SSE session replaces the previous attachment for the same machine [AC:registered-machine-desktop-agent#AC-4]', async () => {
  const hub = createDesktopAgentHub();
  const first = eventsSink();
  const second = eventsSink();
  const a = createDesktopAgentHttpSseSession({
    hub,
    machineId: 'desk',
    send: first.send,
    newRequestId: () => 'a1'
  });
  const b = createDesktopAgentHttpSseSession({
    hub,
    machineId: 'desk',
    send: second.send,
    newRequestId: () => 'b1'
  });
  assert.equal(hub.isAttached('desk'), true);

  const backend = createCompositeRegisteredMachineBackend({ agentHub: hub });
  const op = backend.read(machine(), { path: 'note.txt' });
  await Promise.resolve();
  assert.equal(first.events.length, 0);
  assert.equal(second.events[0].data.requestId, 'b1');
  assert.equal(b.handleReply({ requestId: 'b1', result: { ok: true, content: 'via-b' } }), true);
  assert.equal((await op).content, 'via-b');

  a.close();
  assert.equal(hub.isAttached('desk'), true, 'closing the replaced session must not drop the live one');
  b.close();
  assert.equal(hub.isAttached('desk'), false);
});

test('HTTP/SSE attach never calls ssh and never touches Factory settings [AC:registered-machine-desktop-agent#AC-4]', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rm-sse-'));
  const sshLog = join(dir, 'ssh.log');
  const sshBin = join(dir, 'ssh');
  writeFileSync(sshBin, `#!/bin/sh\nprintf 'SSH_CALLED\\n' >> "${sshLog}"\nexit 255\n`);
  chmodSync(sshBin, 0o755);
  writeFileSync(sshLog, '');

  const store = new SqliteStateStore(join(dir, 'state.db'));
  const principal = { userId: 'owner' };
  const hub = createDesktopAgentHub();
  const backend = createCompositeRegisteredMachineBackend({ agentHub: hub, ssh: { sshBin } });
  const port = createRegisteredMachinePort(store, backend);
  port.register(principal, { machineId: 'desk', label: 'Desk', kind: 'desktop', sshAlias: 'desk-host' });

  const sink = eventsSink();
  const session = createDesktopAgentHttpSseSession({
    hub,
    machineId: 'desk',
    send: sink.send,
    newRequestId: () => 'req-1'
  });
  const shellP = port.shell(principal, 'desk', { command: 'via-sse' });
  // port.shell awaits probeLive before dispatching; flush until the SSE op is emitted
  for (let i = 0; i < 50 && sink.events.length === 0; i++) await Promise.resolve();
  assert.equal(sink.events.length, 1);
  assert.equal(sink.events[0].data.kind, 'shell');
  session.handleReply({ requestId: 'req-1', result: { ok: true, content: 'agent', exitCode: 0 } });
  const shell = await shellP;
  assert.equal(shell.ok, true);
  assert.equal(shell.content, 'agent');
  assert.equal(readFileSync(sshLog, 'utf8').includes('SSH_CALLED'), false);

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
  const factory = new FactoryService({ store, rooms });
  assert.deepEqual(factory.settings(principal).machines, []);
  session.close();
});
