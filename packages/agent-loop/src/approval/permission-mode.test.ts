import { describe, expect, it } from 'vitest';
import {
  applyPermissionModeGate,
  comparePermissionMode,
  describePermissionMode,
  explainToolUnderMode,
  isEditTool,
  isReadOnlyTool,
  parsePermissionMode,
  resolvePermissionMode,
  shiftPermissionMode,
  type PermissionMode,
} from './permission-mode.js';

const MODES: PermissionMode[] = ['plan', 'ask', 'acceptEdits', 'auto', 'bypass'];

describe('parsePermissionMode', () => {
  it('accepts known modes', () => {
    for (const mode of MODES) {
      expect(parsePermissionMode(mode)).toBe(mode);
    }
  });

  it('trims whitespace', () => {
    expect(parsePermissionMode('  ask  ')).toBe('ask');
  });

  it('rejects unknown or non-string values', () => {
    expect(parsePermissionMode('nope')).toBeUndefined();
    expect(parsePermissionMode('AUTO')).toBeUndefined();
    expect(parsePermissionMode('')).toBeUndefined();
    expect(parsePermissionMode(undefined)).toBeUndefined();
    expect(parsePermissionMode(1)).toBeUndefined();
    expect(parsePermissionMode({ permissionMode: 'ask' })).toBeUndefined();
  });
});

describe('resolvePermissionMode', () => {
  it('prefers session metadata over string env', () => {
    expect(resolvePermissionMode({ permissionMode: 'plan' }, 'ask')).toBe('plan');
  });

  it('prefers session metadata over ProcessEnv', () => {
    expect(
      resolvePermissionMode({ permissionMode: 'plan' }, { RAW_AGENT_PERMISSION_MODE: 'ask' })
    ).toBe('plan');
  });

  it('reads string env when session is empty', () => {
    expect(resolvePermissionMode({}, 'ask')).toBe('ask');
    expect(resolvePermissionMode(undefined, 'bypass')).toBe('bypass');
  });

  it('reads RAW_AGENT_PERMISSION_MODE from ProcessEnv', () => {
    expect(resolvePermissionMode({}, { RAW_AGENT_PERMISSION_MODE: 'ask' })).toBe('ask');
    expect(resolvePermissionMode({}, {})).toBe('auto');
  });

  it('defaults to auto when env is missing or invalid', () => {
    expect(resolvePermissionMode({})).toBe('auto');
    expect(resolvePermissionMode({}, 'nope')).toBe('auto');
    expect(resolvePermissionMode({}, { RAW_AGENT_PERMISSION_MODE: 'nope' })).toBe('auto');
    expect(resolvePermissionMode({ permissionMode: 'nope' }, 'ask')).toBe('ask');
  });
});

describe('tool classifiers', () => {
  it('marks read-only and edit tools', () => {
    expect(isReadOnlyTool('read_file')).toBe(true);
    expect(isReadOnlyTool('retrieve_tool_result')).toBe(true);
    expect(isReadOnlyTool('bash')).toBe(false);
    expect(isEditTool('write_file')).toBe(true);
    expect(isEditTool('edit_file')).toBe(true);
    expect(isEditTool('notebook_edit')).toBe(true);
    expect(isEditTool('bash')).toBe(false);
  });
});

describe('describePermissionMode / shift / compare', () => {
  it('describes every mode', () => {
    expect(describePermissionMode('plan')).toMatch(/Read-only/i);
    expect(describePermissionMode('ask')).toMatch(/approval/i);
    expect(describePermissionMode('acceptEdits')).toMatch(/edit/i);
    expect(describePermissionMode('auto')).toMatch(/Defer/i);
    expect(describePermissionMode('bypass')).toMatch(/Never/i);
  });

  it('shifts along the spectrum and clamps at ends', () => {
    expect(shiftPermissionMode('plan', 'elevate')).toBe('ask');
    expect(shiftPermissionMode('auto', 'demote')).toBe('acceptEdits');
    expect(shiftPermissionMode('plan', 'demote')).toBe('plan');
    expect(shiftPermissionMode('bypass', 'elevate')).toBe('bypass');
  });

  it('compares autonomy rank', () => {
    expect(comparePermissionMode('plan', 'ask')).toBeLessThan(0);
    expect(comparePermissionMode('bypass', 'auto')).toBeGreaterThan(0);
    expect(comparePermissionMode('auto', 'auto')).toBe(0);
  });
});

describe('applyPermissionModeGate', () => {
  it('bypass always proceeds', () => {
    expect(applyPermissionModeGate('bypass', 'bash', 'always')).toEqual({ action: 'proceed' });
  });

  it('plan allows genuine read-only never tools', () => {
    expect(applyPermissionModeGate('plan', 'read_file', 'never')).toEqual({ action: 'proceed' });
    expect(applyPermissionModeGate('plan', 'search_skills', 'never')).toEqual({ action: 'proceed' });
    expect(applyPermissionModeGate('plan', 'retrieve_tool_result', 'never')).toEqual({
      action: 'proceed',
    });
  });

  it('plan denies side-effect tools even when marked never', () => {
    for (const name of ['bash', 'bg_run', 'write_file', 'edit_file', 'claude_code', 'codex_exec', 'cursor_agent']) {
      const gate = applyPermissionModeGate('plan', name, 'never');
      expect(gate?.action).toBe('deny');
      if (gate?.action === 'deny') {
        expect(gate.code).toBe('PERMISSION_MODE_PLAN_SIDE_EFFECT');
        expect(gate.remediation).toMatch(/permissionMode/);
      }
    }
  });

  it('plan denies non-readonly tools', () => {
    const deny = applyPermissionModeGate('plan', 'bash', 'auto');
    expect(deny?.action).toBe('deny');
    if (deny?.action === 'deny') {
      expect(deny.code).toBe('PERMISSION_MODE_PLAN_READONLY');
      expect(deny.remediation).toBeTruthy();
    }
  });

  it('ask proceeds only for never + read-only', () => {
    expect(applyPermissionModeGate('ask', 'read_file', 'never')).toEqual({ action: 'proceed' });
    const write = applyPermissionModeGate('ask', 'write_file', 'auto');
    expect(write?.action).toBe('require_approval');
    if (write?.action === 'require_approval') {
      expect(write.code).toBe('PERMISSION_MODE_ASK');
      expect(write.remediation).toBeTruthy();
    }
    expect(applyPermissionModeGate('ask', 'read_file', 'auto')?.action).toBe('require_approval');
  });

  it('acceptEdits auto-approves edit tools and defers others', () => {
    expect(applyPermissionModeGate('acceptEdits', 'edit_file', 'auto')).toEqual({
      action: 'proceed',
    });
    expect(applyPermissionModeGate('acceptEdits', 'bash', 'auto')).toBeUndefined();
  });

  it('auto defers to policy', () => {
    expect(applyPermissionModeGate('auto', 'bash', 'auto')).toBeUndefined();
    expect(applyPermissionModeGate('auto', 'read_file', 'never')).toBeUndefined();
  });
});

describe('explainToolUnderMode', () => {
  it('maps gate outcomes for Lab UX', () => {
    expect(explainToolUnderMode('plan', 'bash').decision).toBe('deny');
    expect(explainToolUnderMode('ask', 'write_file').decision).toBe('require_approval');
    expect(explainToolUnderMode('bypass', 'bash').decision).toBe('proceed');
    expect(explainToolUnderMode('auto', 'bash').decision).toBe('defer_to_policy');
    expect(explainToolUnderMode('acceptEdits', 'edit_file').decision).toBe('proceed');
    expect(explainToolUnderMode('acceptEdits', 'bash').decision).toBe('defer_to_policy');
  });
});

it('allows history evidence recovery in read-only planning [AC:context-reliability#AC-5]', () => {
  for (const name of ['history_search', 'history_read', 'memory_read']) {
    expect(isReadOnlyTool(name)).toBe(true);
    expect(applyPermissionModeGate('plan', name, 'never')).toEqual({ action: 'proceed' });
  }
});
