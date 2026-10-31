import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRegister,
  applyUnregister,
  applyRefresh
} from './registered-machines-actions.ts';
import type { RegisteredMachineSummary } from './registered-machines-model.ts';

// [AC:lab-registered-machines#AC-1] [AC:lab-registered-machines#AC-2] [AC:lab-registered-machines#AC-3] [AC:lab-registered-machines#AC-4]

describe('registered-machines-actions', () => {
  describe('applyRegister', () => {
    it('appends new machine and replaces existing one', () => {
      const machines: RegisteredMachineSummary[] = [
        { machineId: 'mac1', label: 'Old Mac', kind: 'desktop', connected: false }
      ];
      const newMachine: RegisteredMachineSummary = {
        machineId: 'mac1',
        label: 'Updated Mac',
        kind: 'desktop',
        connected: true
      };
      const result = applyRegister(machines, newMachine);
      assert.equal(result.length, 1);
      assert.equal(result[0].label, 'Updated Mac');
      assert.equal(result[0].connected, true);
    });

    it('adds completely new machine', () => {
      const machines: RegisteredMachineSummary[] = [
        { machineId: 'mac1', label: 'Mac', kind: 'desktop', connected: true }
      ];
      const newMachine: RegisteredMachineSummary = {
        machineId: 'phone1',
        label: 'iPhone',
        kind: 'phone',
        connected: false
      };
      const result = applyRegister(machines, newMachine);
      assert.equal(result.length, 2);
      assert.equal(result[1].machineId, 'phone1');
    });
  });

  describe('applyUnregister', () => {
    it('removes specified machine', () => {
      const machines: RegisteredMachineSummary[] = [
        { machineId: 'mac1', label: 'Mac', kind: 'desktop', connected: true },
        { machineId: 'phone1', label: 'Phone', kind: 'phone', connected: false }
      ];
      const result = applyUnregister(machines, 'mac1');
      assert.equal(result.length, 1);
      assert.equal(result[0].machineId, 'phone1');
    });

    it('handles non-existent machine gracefully', () => {
      const machines: RegisteredMachineSummary[] = [
        { machineId: 'mac1', label: 'Mac', kind: 'desktop', connected: true }
      ];
      const result = applyUnregister(machines, 'nonexistent');
      assert.equal(result.length, 1);
      assert.equal(result[0].machineId, 'mac1');
    });
  });

  describe('applyRefresh', () => {
    it('updates connection status for matching machine', () => {
      const machines: RegisteredMachineSummary[] = [
        { machineId: 'mac1', label: 'Mac', kind: 'desktop', connected: false },
        { machineId: 'phone1', label: 'Phone', kind: 'phone', connected: true }
      ];
      const refreshed: RegisteredMachineSummary = {
        machineId: 'mac1',
        label: 'Mac',
        kind: 'desktop',
        connected: true
      };
      const result = applyRefresh(machines, refreshed);
      assert.equal(result.length, 2);
      assert.equal(result[0].connected, true);
      assert.equal(result[1].machineId, 'phone1');
    });

    it('preserves other machines unchanged', () => {
      const machines: RegisteredMachineSummary[] = [
        { machineId: 'mac1', label: 'Mac', kind: 'desktop', connected: false },
        { machineId: 'phone1', label: 'Phone', kind: 'phone', connected: true }
      ];
      const refreshed: RegisteredMachineSummary = {
        machineId: 'mac1',
        label: 'Mac Updated',
        kind: 'desktop',
        connected: true
      };
      const result = applyRefresh(machines, refreshed);
      assert.equal(result[0].label, 'Mac Updated');
      assert.equal(result[1].label, 'Phone');
      assert.equal(result[1].connected, true);
    });
  });
});
