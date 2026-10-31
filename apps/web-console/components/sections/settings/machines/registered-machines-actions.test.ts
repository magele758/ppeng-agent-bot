import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRegister,
  applyUnregister,
  applyRefresh,
  loadMachines,
  registerMachine,
  unregisterMachine,
  refreshMachine
} from './registered-machines-actions.ts';

const sample = {
  machineId: 'mac1',
  label: 'My MacBook',
  kind: 'desktop' as const,
  connected: true,
  sshAlias: 'mbp'
};

test('loadMachines lists live machines via api stub [AC:lab-registered-machines#AC-1]', async () => {
  const listed = await loadMachines(async () => ({ machines: [{ ...sample }] }));
  assert.ok('machines' in listed && listed.machines[0]?.machineId === 'mac1');
  assert.equal(listed.machines[0]?.kind, 'desktop');
  assert.equal(listed.machines[0]?.connected, true);
});

test('registerMachine posts form fields and returns machine [AC:lab-registered-machines#AC-2]', async () => {
  const registered = await registerMachine(
    async (_path, init) => {
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body ?? '{}'));
      assert.equal(body.machineId, 'mac2');
      assert.equal(body.label, 'MacBook');
      assert.equal(body.kind, 'desktop');
      return {
        machine: {
          machineId: 'mac2',
          label: 'MacBook',
          kind: 'desktop',
          connected: false
        }
      };
    },
    { machineId: 'mac2', label: 'MacBook', kind: 'desktop' }
  );
  assert.ok('machine' in registered && registered.machine.machineId === 'mac2');
  const rows = applyRegister([], registered.machine);
  assert.equal(rows.length, 1);
});

test('unregisterMachine deletes and applyUnregister drops row [AC:lab-registered-machines#AC-3]', async () => {
  const deleted = await unregisterMachine(async (path, init) => {
    assert.match(path, /\/api\/registered-machines\/mac1$/);
    assert.equal(init?.method, 'DELETE');
    return {};
  }, 'mac1');
  assert.deepEqual(deleted, { ok: true });
  const rows = applyUnregister([{ ...sample }, { ...sample, machineId: 'phone1', kind: 'phone', connected: false }], 'mac1');
  assert.deepEqual(rows.map((r) => r.machineId), ['phone1']);
});

test('refreshMachine probes and applyRefresh updates connected [AC:lab-registered-machines#AC-4]', async () => {
  const refreshed = await refreshMachine(async (path, init) => {
    assert.match(path, /\/api\/registered-machines\/mac1\/refresh$/);
    assert.equal(init?.method, 'POST');
    return { machine: { ...sample, connected: true } };
  }, 'mac1');
  assert.ok('machine' in refreshed && refreshed.machine.connected === true);
  const rows = applyRefresh([{ ...sample, connected: false }], refreshed.machine);
  assert.equal(rows[0]?.connected, true);
});

test('api failures return error strings [AC:lab-registered-machines#AC-1]', async () => {
  const fail = async () => {
    throw new Error('boom');
  };
  assert.equal((await loadMachines(fail) as { error: string }).error, 'boom');
  assert.equal((await registerMachine(fail, { machineId: 'x', label: 'y', kind: 'desktop' }) as { error: string }).error, 'boom');
  assert.equal((await unregisterMachine(fail, 'x') as { error: string }).error, 'boom');
  assert.equal((await refreshMachine(fail, 'x') as { error: string }).error, 'boom');
});
