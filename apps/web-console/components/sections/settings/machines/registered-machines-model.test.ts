import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMachineList,
  parseMachine,
  applyRegister,
  applyUnregister,
  applyRefresh,
  attachHintForKind
} from './registered-machines-model.ts';

test('parseMachineList keeps id/label/kind/connected and drops junk [AC:lab-registered-machines#AC-1]', () => {
  const machines = parseMachineList({
    machines: [
      {
        machineId: 'mac1',
        label: 'My MacBook',
        kind: 'desktop',
        connected: true,
        sshAlias: 'mbp'
      },
      {
        machineId: 'phone1',
        label: 'iPhone',
        kind: 'phone',
        connected: false,
        deviceLocalTools: [{ tool: 'shell' }]
      },
      { machineId: 'invalid' },
      null
    ]
  });
  assert.equal(machines.length, 2);
  assert.equal(machines[0]?.machineId, 'mac1');
  assert.equal(machines[0]?.label, 'My MacBook');
  assert.equal(machines[0]?.kind, 'desktop');
  assert.equal(machines[0]?.connected, true);
  assert.equal(machines[1]?.machineId, 'phone1');
  assert.equal(machines[1]?.connected, false);
});

test('applyRegister adds machine from form fields [AC:lab-registered-machines#AC-2]', () => {
  const machines = [{ machineId: 'mac1', label: 'Mac', kind: 'desktop' as const, connected: true }];
  const registered = {
    machineId: 'mac2',
    label: 'MacBook',
    kind: 'desktop' as const,
    connected: false
  };
  const result = applyRegister(machines, registered);
  assert.equal(result.length, 2);
  assert.equal(result[1]?.machineId, 'mac2');
  assert.equal(result[1]?.label, 'MacBook');
  assert.equal(result[1]?.kind, 'desktop');
});

test('applyUnregister removes machine from list [AC:lab-registered-machines#AC-3]', () => {
  const machines = [
    { machineId: 'mac1', label: 'Mac', kind: 'desktop' as const, connected: true },
    { machineId: 'mac2', label: 'MacBook', kind: 'phone' as const, connected: false }
  ];
  const result = applyUnregister(machines, 'mac1');
  assert.equal(result.length, 1);
  assert.equal(result[0]?.machineId, 'mac2');
});

test('applyRefresh updates connection status from live probe [AC:lab-registered-machines#AC-4]', () => {
  const machines = [
    { machineId: 'mac1', label: 'Mac', kind: 'desktop' as const, connected: false },
    { machineId: 'mac2', label: 'Phone', kind: 'phone' as const, connected: true }
  ];
  const refreshed = { machineId: 'mac1', label: 'Mac', kind: 'desktop' as const, connected: true };
  const result = applyRefresh(machines, refreshed);
  assert.equal(result[0]?.connected, true);
  assert.equal(result[1]?.machineId, 'mac2');
});

test('attach hints are desktop-agent / device-local SSE, never Factory SSH UI [AC:lab-registered-machines#AC-5]', () => {
  assert.match(attachHintForKind('desktop'), /\/api\/desktop-agent\/:id\/events/);
  assert.match(attachHintForKind('phone'), /\/api\/device-local\/:id\/events/);
  assert.equal(/factory/i.test(attachHintForKind('desktop')), false);
  assert.equal(/factory/i.test(attachHintForKind('phone')), false);
  assert.equal(/factory/i.test(attachHintForKind('other')), false);
  assert.equal(/ssh\s*ui/i.test(attachHintForKind('other')), false);
});

test('parseMachine requires id/label/kind', () => {
  assert.equal(parseMachine(null), null);
  assert.equal(parseMachine({}), null);
  const machine = parseMachine({
    machine: {
      machineId: 'desktop1',
      label: 'Work Mac',
      kind: 'desktop',
      connected: true,
      sshAlias: 'work'
    }
  });
  assert.equal(machine?.machineId, 'desktop1');
  assert.equal(machine?.connected, true);
});
