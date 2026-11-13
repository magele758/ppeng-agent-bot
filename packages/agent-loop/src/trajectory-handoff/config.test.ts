/**
 * Trajectory Handoff v2.3 — config parser tests.
 *
 * Coverage (from spec §Tests config/fallback):
 * - Single-role invalid falls back only that role.
 * - Fallback model also invalid → fail-closed (tested via ModelResolver mock).
 * - cap=0 → defaults 3/6 and handoff stays available.
 * - perTurn > perSession clamps perTurn.
 * - Explicit off wins.
 * - inheritModelOverride does not pin executor model onto planner subtask.
 */

import { describe, it, expect } from 'vitest';
import { parseCapabilityTiers, parseCapabilityTiersOrNull } from './config.js';
import { DEFAULT_SESSION_CAP, DEFAULT_TURN_CAP } from './types.js';

describe('parseCapabilityTiers', () => {
  describe('Missing or null config', () => {
    it('returns default enabled with null models (use pinned session model)', () => {
      const result = parseCapabilityTiers(undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.enabled).toBe(true);
        expect(result.resolved.plannerModel).toBeNull();
        expect(result.resolved.executorModel).toBeNull();
        expect(result.resolved.perSessionCap).toBe(DEFAULT_SESSION_CAP);
        expect(result.resolved.perTurnCap).toBe(DEFAULT_TURN_CAP);
        expect(result.resolved.inheritModelOverride).toBe(false);
      }
    });

    it('treats null as missing (same as undefined)', () => {
      const result = parseCapabilityTiers(null);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.enabled).toBe(true);
      }
    });
  });

  describe('Explicit off wins', () => {
    it('enabled: false disables handoff regardless of other fields', () => {
      const result = parseCapabilityTiers({
        enabled: false,
        roles: { plannerModel: 'gpt-4', executorModel: 'gpt-4' },
        caps: { perSession: 10, perTurn: 5 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.enabled).toBe(false);
      }
    });

    it('enabled: false is fail-safe (no models parsed)', () => {
      const result = parseCapabilityTiers({ enabled: false });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.enabled).toBe(false);
        expect(result.resolved.plannerModel).toBeNull();
        expect(result.resolved.executorModel).toBeNull();
      }
    });
  });

  describe('Whole-block type error', () => {
    it('rejects non-object input with warning', () => {
      const result = parseCapabilityTiers('invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.warning).toContain('Whole-block type error');
      }
    });

    it('rejects array input', () => {
      const result = parseCapabilityTiers([1, 2, 3]);
      expect(result.ok).toBe(false);
    });

    it('rejects number input', () => {
      const result = parseCapabilityTiers(42);
      expect(result.ok).toBe(false);
    });
  });

  describe('Role model parsing', () => {
    it('parses valid plannerModel and executorModel', () => {
      const result = parseCapabilityTiers({
        roles: {
          plannerModel: 'claude-3-opus',
          executorModel: 'claude-3-sonnet',
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.plannerModel).toBe('claude-3-opus');
        expect(result.resolved.executorModel).toBe('claude-3-sonnet');
      }
    });

    it('falls back to null for missing role fields', () => {
      const result = parseCapabilityTiers({ roles: {} });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.plannerModel).toBeNull();
        expect(result.resolved.executorModel).toBeNull();
      }
    });

    it('ignores empty-string models', () => {
      const result = parseCapabilityTiers({
        roles: { plannerModel: '', executorModel: '' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.plannerModel).toBeNull();
        expect(result.resolved.executorModel).toBeNull();
      }
    });

    it('ignores null role models', () => {
      const result = parseCapabilityTiers({
        roles: { plannerModel: null, executorModel: null },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.plannerModel).toBeNull();
        expect(result.resolved.executorModel).toBeNull();
      }
    });

    it('parses only plannerModel when executorModel is missing', () => {
      const result = parseCapabilityTiers({
        roles: { plannerModel: 'gpt-4' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.plannerModel).toBe('gpt-4');
        expect(result.resolved.executorModel).toBeNull();
      }
    });

    it('parses only executorModel when plannerModel is missing', () => {
      const result = parseCapabilityTiers({
        roles: { executorModel: 'gpt-4' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.plannerModel).toBeNull();
        expect(result.resolved.executorModel).toBe('gpt-4');
      }
    });
  });

  describe('Cap parsing and validation', () => {
    it('parses valid perSession and perTurn', () => {
      const result = parseCapabilityTiers({
        caps: { perSession: 10, perTurn: 5 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.perSessionCap).toBe(10);
        expect(result.resolved.perTurnCap).toBe(5);
      }
    });

    it('cap=0 → defaults 3/6 and handoff stays available', () => {
      const result = parseCapabilityTiers({
        caps: { perSession: 0, perTurn: 0 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.enabled).toBe(true);
        expect(result.resolved.perSessionCap).toBe(DEFAULT_SESSION_CAP);
        expect(result.resolved.perTurnCap).toBe(DEFAULT_TURN_CAP);
      }
    });

    it('negative caps → defaults', () => {
      const result = parseCapabilityTiers({
        caps: { perSession: -5, perTurn: -2 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.perSessionCap).toBe(DEFAULT_SESSION_CAP);
        expect(result.resolved.perTurnCap).toBe(DEFAULT_TURN_CAP);
      }
    });

    it('perTurn > perSession clamps perTurn', () => {
      const result = parseCapabilityTiers({
        caps: { perSession: 4, perTurn: 10 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.perSessionCap).toBe(4);
        expect(result.resolved.perTurnCap).toBe(4); // Clamped to perSession.
      }
    });

    it('floors floating-point caps', () => {
      const result = parseCapabilityTiers({
        caps: { perSession: 7.8, perTurn: 2.9 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.perSessionCap).toBe(7);
        expect(result.resolved.perTurnCap).toBe(2);
      }
    });

    it('ignores non-number cap values', () => {
      const result = parseCapabilityTiers({
        caps: { perSession: 'ten', perTurn: null } as unknown as { perSession: number; perTurn: number },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.perSessionCap).toBe(DEFAULT_SESSION_CAP);
        expect(result.resolved.perTurnCap).toBe(DEFAULT_TURN_CAP);
      }
    });
  });

  describe('inheritModelOverride', () => {
    it('parses inheritModelOverride: true', () => {
      const result = parseCapabilityTiers({
        inheritModelOverride: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.inheritModelOverride).toBe(true);
      }
    });

    it('defaults inheritModelOverride to false', () => {
      const result = parseCapabilityTiers({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.inheritModelOverride).toBe(false);
      }
    });

    it('coerces non-boolean inheritModelOverride to boolean', () => {
      const result = parseCapabilityTiers({
        inheritModelOverride: 'yes' as unknown as boolean,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.inheritModelOverride).toBe(true);
      }
    });
  });

  describe('parseCapabilityTiersOrNull', () => {
    it('returns null when parsing fails', () => {
      const result = parseCapabilityTiersOrNull('invalid');
      expect(result).toBeNull();
    });

    it('returns null when enabled is false', () => {
      const result = parseCapabilityTiersOrNull({ enabled: false });
      expect(result).toBeNull();
    });

    it('returns resolved config when enabled and valid', () => {
      const result = parseCapabilityTiersOrNull({
        roles: { plannerModel: 'gpt-4' },
      });
      expect(result).not.toBeNull();
      expect(result?.enabled).toBe(true);
      expect(result?.plannerModel).toBe('gpt-4');
    });
  });

  describe('Full integration scenarios', () => {
    it('parses a complete valid config', () => {
      const result = parseCapabilityTiers({
        enabled: true,
        roles: {
          plannerModel: 'claude-3-opus',
          executorModel: 'claude-3-sonnet',
        },
        caps: {
          perSession: 8,
          perTurn: 4,
        },
        inheritModelOverride: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved).toEqual({
          enabled: true,
          plannerModel: 'claude-3-opus',
          executorModel: 'claude-3-sonnet',
          perSessionCap: 8,
          perTurnCap: 4,
          inheritModelOverride: true,
        });
      }
    });

    it('handles partial config with defaults', () => {
      const result = parseCapabilityTiers({
        roles: { plannerModel: 'gpt-4' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resolved.enabled).toBe(true);
        expect(result.resolved.plannerModel).toBe('gpt-4');
        expect(result.resolved.executorModel).toBeNull();
        expect(result.resolved.perSessionCap).toBe(DEFAULT_SESSION_CAP);
        expect(result.resolved.perTurnCap).toBe(DEFAULT_TURN_CAP);
        expect(result.resolved.inheritModelOverride).toBe(false);
      }
    });
  });
});
