import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMachineList, parseMachine, applyRegister, applyUnregister, applyRefresh } from './registered-machines-model.ts';

describe('registered-machines-model', () => {
  describe('parseMachineList', () => {
    it('returns empty list for invalid data', () => {
      assert.deepEqual(parseMachineList(null), []);
      assert.deepEqual(parseMachineList(undefined), []);
      assert.deepEqual(parseMachineList({}), []);
      assert.deepEqual(parseMachineList({ machines: null }), []);
      assert.deepEqual(parseMachineList({ machines: 'not-array' }), []);
    });

    it('parses valid machine list', () => {
      const result = parseMachineList({
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
          }
        ]
      });
      assert.equal(result.length, 2);
      assert.equal(result[0].machineId, 'mac1');
      assert.equal(result[0].label, 'My MacBook');
      assert.equal(result[0].kind, 'desktop');
      assert.equal(result[0].connected, true);
      assert.equal(result[0].sshAlias, 'mbp');
      assert.equal(result[1].machineId, 'phone1');
      assert.equal(result[1].connected, false);
    });

    it('skips invalid entries', () => {
      const result = parseMachineList({
        machines: [
          { machineId: 'mac1', label: 'Valid', kind: 'desktop', connected: true },
          { machineId: 'invalid' },
          null,
          { machineId: 'mac2', label: 'Another', kind: 'phone', connected: false }
        ]
      });
      assert.equal(result.length, 2);
      assert.equal(result[0].machineId, 'mac1');
      assert.equal(result[1].machineId, 'mac2');
    });
  });

  describe('parseMachine', () => {
    it('returns null for invalid data', () => {
      assert.equal(parseMachine(null), null);
      assert.equal(parseMachine({}), null);
      assert.equal(parseMachine({ machine: null }), null);
    });

    it('parses valid machine', () => {
      const result = parseMachine({
        machine: {
          machineId: 'desktop1',
          label: 'Work Mac',
          kind: 'desktop',
          connected: true,
          sshAlias: 'work'
        }
      });
      assert.notEqual(result, null);
      assert.equal(result?.machineId, 'desktop1');
      assert.equal(result?.label, 'Work Mac');
      assert.equal(result?.connected, true);
    });
  });

  describe('applyRegister', () => {
    it('adds new machine to list', () => {
      const machines = [{ machineId: 'mac1', label: 'Mac', kind: 'desktop' as const, connected: true }];
      const newMachine = { machineId: 'mac2', label: 'MacBook', kind: 'desktop' as const, connected: false };
      const result = applyRegister(machines, newMachine);
      assert.equal(result.length, 2);
      assert.equal(result[1].machineId, 'mac2');
    });

    it('replaces existing machine', () => {
      const machines = [
        { machineId: 'mac1', label: 'Old', kind: 'desktop' as const, connected: false },
        { machineId: 'mac2', label: 'Other', kind: 'phone' as const, connected: true }
      ];
      const updated = { machineId: 'mac1', label: 'New', kind: 'desktop' as const, connected: true };
      const result = applyRegister(machines, updated);
      assert.equal(result.length, 2);
      assert.equal(result[0].machineId, 'mac2');
      assert.equal(result[1].label, 'New');
      assert.equal(result[1].connected, true);
    });
  });

  describe('applyUnregister', () => {
    it('removes machine from list', () => {
      const machines = [
        { machineId: 'mac1', label: 'Mac', kind: 'desktop' as const, connected: true },
        { machineId: 'mac2', label: 'MacBook', kind: 'phone' as const, connected: false }
      ];
      const result = applyUnregister(machines, 'mac1');
      assert.equal(result.length, 1);
      assert.equal(result[0].machineId, 'mac2');
    });

    it('handles missing machine', () => {
      const machines = [{ machineId: 'mac1', label: 'Mac', kind: 'desktop' as const, connected: true }];
      const result = applyUnregister(machines, 'nonexistent');
      assert.equal(result.length, 1);
    });
  });

  describe('applyRefresh', () => {
    it('updates machine connection status', () => {
      const machines = [
        { machineId: 'mac1', label: 'Mac', kind: 'desktop' as const, connected: false },
        { machineId: 'mac2', label: 'Phone', kind: 'phone' as const, connected: true }
      ];
      const refreshed = { machineId: 'mac1', label: 'Mac', kind: 'desktop' as const, connected: true };
      const result = applyRefresh(machines, refreshed);
      assert.equal(result.length, 2);
      assert.equal(result[0].connected, true);
      assert.equal(result[1].machineId, 'mac2');
    });
  });
});
